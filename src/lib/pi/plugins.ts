/**
 * Global Pi plugins: the admin-managed extension directory every session loads.
 *
 * A plugin is a directory (or a single `.ts`/`.js` file) under one directory,
 * loaded into `DefaultResourceLoader` through `additionalExtensionPaths`. Pi
 * discovers a directory's `package.json` `pi.extensions`, its `extensions/`
 * folder, or its `index.ts`.
 *
 * Plugins are trusted code: they run inside this process, with the app's
 * permissions and access to every tenant's data. Only an admin can point
 * Saale at a directory, and only an admin can switch a plugin on.
 *
 * The host's own Pi settings never leak in: `createAgentResourceLoader` keeps
 * `noExtensions: true`, so `additionalExtensionPaths` is the only source of
 * file extensions a session loads.
 *
 * Every path here comes from an admin at runtime, so the fs calls carry
 * `turbopackIgnore`: static analysis would trace the whole project into the
 * standalone build for a directory that is not part of it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizePluginStates } from "@/lib/settings/properties";
import { getUploadsDir } from "@/lib/uploads";
import { createSessionSettings } from "./settings";

const execFileAsync = promisify(execFile);

/** Fallback directory, under the shared uploads volume so web and worker agree. */
export function defaultPluginsDir(): string {
  return path.join(getUploadsDir(), "pi_plugins");
}

/**
 * The directory the admin configured, or the environment's.
 *
 * `PI_GLOBAL_PLUGINS_DIR` lets a deployment pin the directory (and mount it)
 * without a database write; the admin setting wins when it is set.
 */
export function resolvePluginsDir(stored: string | null | undefined): string {
  const configured = stored?.trim();
  if (configured) return path.resolve(configured);
  const fromEnv = process.env.PI_GLOBAL_PLUGINS_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return defaultPluginsDir();
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface PluginConfig {
  /** Absolute directory scanned for plugins. */
  dir: string;
  /** What the admin stored (empty means the default was used). */
  dirSetting: string;
  /** Master switch. */
  enabled: boolean;
  /** Whether a plugin may open a dialog in a chat (`ctx.ui`). */
  ui: boolean;
  /** Per-plugin switches, keyed by plugin id. */
  states: Record<string, { enabled: boolean }>;
}

/**
 * Read the plugin settings.
 *
 * Read straight from the row rather than through `ensureAdminSettings`: this
 * runs while a session is being built, and a read must not create a row.
 */
export async function readPluginConfig(): Promise<PluginConfig> {
  const row = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: {
      piPluginsDir: true,
      piPluginsEnabled: true,
      piPluginStates: true,
      piPluginsUi: true,
    },
  });
  return {
    dir: resolvePluginsDir(row?.piPluginsDir),
    dirSetting: row?.piPluginsDir ?? "",
    enabled: row?.piPluginsEnabled ?? false,
    ui: row?.piPluginsUi ?? true,
    states: normalizePluginStates(row?.piPluginStates),
  };
}

// ─── Discovery ───────────────────────────────────────────────────────────────

export interface PluginGitInfo {
  branch: string | null;
  commit: string;
  commitDate: string | null;
  /** Tracked files differ from HEAD. */
  dirty: boolean;
}

export type PluginStatus = "loaded" | "error" | "disabled" | "unknown";

/** A folder or file dropped into the directory, or an npm package installed from it. */
export type PluginKind = "directory" | "file" | "package";

export interface PluginInfo {
  /** Directory (or file) name. Stable across reloads; the switch is keyed by it. */
  id: string;
  path: string;
  kind: PluginKind;
  name: string;
  version: string | null;
  description: string | null;
  /** Entry files Pi loads, relative to the plugin root. */
  entries: string[];
  /** Runtime packages the plugin declares. */
  dependencies: string[];
  /** Effective state: the master switch and the per-plugin switch both apply. */
  enabled: boolean;
  /** The plugin's own switch, `null` when it was never set (on by default). */
  override: boolean | null;
  status: PluginStatus;
  errors: string[];
  warnings: string[];
  /** Newest file mtime in the plugin, ISO. */
  updatedAt: string | null;
  /** Changes whenever a file in the plugin changes. */
  revision: string;
  git: PluginGitInfo | null;
}

/** Directories never walked when reading a plugin's files. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);
const MAX_WALKED_FILES = 400;

interface WalkedFile {
  relative: string;
  mtimeMs: number;
  size: number;
}

async function walkPluginFiles(root: string): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  const pending = [""];

  while (pending.length > 0 && files.length < MAX_WALKED_FILES) {
    const relativeDir = pending.pop() ?? "";
    const absoluteDir = path.join(root, relativeDir);
    let entries;
    try {
      entries = await readdir(/*turbopackIgnore: true*/ absoluteDir, { withFileTypes: true });
    } catch (err) {
      console.error(`Failed to read plugin directory ${absoluteDir}:`, err);
      continue;
    }

    for (const entry of entries) {
      if (files.length >= MAX_WALKED_FILES) break;
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        pending.push(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(
          /*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, relative),
        );
        files.push({ relative, mtimeMs: info.mtimeMs, size: info.size });
      } catch (err) {
        console.error(`Failed to stat plugin file ${relative}:`, err);
      }
    }
  }

  return files;
}

interface PluginManifest {
  name: string | null;
  version: string | null;
  description: string | null;
  dependencies: string[];
  entries: string[];
}

/** The parts of a plugin's `package.json` worth showing. */
async function readManifest(root: string): Promise<PluginManifest> {
  const empty: PluginManifest = {
    name: null,
    version: null,
    description: null,
    dependencies: [],
    entries: [],
  };
  try {
    const raw = await readFile(
      /*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, "package.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pi = parsed.pi as { extensions?: unknown } | undefined;
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      version: typeof parsed.version === "string" ? parsed.version : null,
      description: typeof parsed.description === "string" ? parsed.description : null,
      dependencies: Object.keys((parsed.dependencies as Record<string, unknown> | undefined) ?? {}),
      entries: Array.isArray(pi?.extensions)
        ? pi.extensions.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch (err) {
    // A plugin without a package.json is the common case; a broken one is not.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      recordPluginLog("warn", path.basename(root), `Unreadable package.json: ${message(err)}`);
    }
    return empty;
  }
}

/**
 * Extension entry files, resolved the way Pi resolves a directory source.
 *
 * An npm package gets the strict reading: Pi only loads a package's declared
 * extensions or its `extensions/` folder, and an `index.js` is a plain module
 * that a dependency happens to ship.
 */
async function resolveEntries(
  root: string,
  manifest: PluginManifest,
  options: { allowIndexFile: boolean } = { allowIndexFile: true },
): Promise<string[]> {
  const fromManifest = manifest.entries.filter((entry) => !entry.startsWith("!"));
  if (fromManifest.length > 0) return fromManifest;

  for (const candidate of options.allowIndexFile ? ["index.ts", "index.js"] : []) {
    if (
      existsSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, candidate))
    ) {
      return [candidate];
    }
  }

  const extensionsDir = path.join(root, "extensions");
  if (!existsSync(/*turbopackIgnore: true*/ extensionsDir)) return [];
  try {
    const entries = await readdir(/*turbopackIgnore: true*/ extensionsDir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".js") || entry.name.endsWith(".mjs")),
      )
      .map((entry) => path.join("extensions", entry.name))
      .sort();
  } catch (err) {
    console.error(`Failed to list plugin extensions in ${extensionsDir}:`, err);
    return [];
  }
}

/** A revision string that changes when any file in the plugin changes. */
function revisionOf(files: readonly WalkedFile[]): string {
  const hash = createHash("sha1");
  for (const file of [...files].sort((a, b) => a.relative.localeCompare(b.relative))) {
    hash.update(`${file.relative}:${file.mtimeMs}:${file.size}\n`);
  }
  return hash.digest("hex").slice(0, 12);
}

function newestMtime(files: readonly WalkedFile[]): number | null {
  let newest: number | null = null;
  for (const file of files) {
    if (newest === null || file.mtimeMs > newest) newest = file.mtimeMs;
  }
  return newest;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Plugin roots of the last discovery, for attributing a diagnostic to a plugin. */
let knownRoots: Array<{ id: string; path: string }> = [];

/** The plugin a file path belongs to, if any. */
export function pluginIdForPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  for (const root of knownRoots) {
    if (resolved === root.path || resolved.startsWith(`${root.path}${path.sep}`)) return root.id;
  }
  return null;
}

/** Every plugin in the configured directory, without loading any of them. */
export async function discoverPlugins(config: PluginConfig): Promise<PluginInfo[]> {
  let entries;
  try {
    entries = await readdir(/*turbopackIgnore: true*/ config.dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Failed to read plugins directory ${config.dir}:`, err);
      recordPluginLog("error", null, `Cannot read ${config.dir}: ${message(err)}`);
    }
    knownRoots = [];
    return [];
  }

  const plugins: PluginInfo[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
    const isDirectory = entry.isDirectory();
    const isFile =
      entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts");
    if (!isDirectory && !isFile) continue;

    const pluginPath = path.join(config.dir, entry.name);
    const override = config.states[entry.name]?.enabled ?? null;
    const enabled = config.enabled && override !== false;

    if (isFile) {
      const info = await stat(/*turbopackIgnore: true*/ pluginPath).catch((err) => {
        console.error(`Failed to stat plugin ${pluginPath}:`, err);
        return null;
      });
      const files: WalkedFile[] = info
        ? [{ relative: entry.name, mtimeMs: info.mtimeMs, size: info.size }]
        : [];
      plugins.push({
        id: entry.name,
        path: pluginPath,
        kind: "file",
        name: entry.name.replace(/\.(ts|js|mjs|cjs)$/, ""),
        version: null,
        description: null,
        entries: [entry.name],
        dependencies: [],
        enabled,
        override,
        status: enabled ? "unknown" : "disabled",
        errors: [],
        warnings: [],
        updatedAt: info ? new Date(info.mtimeMs).toISOString() : null,
        revision: revisionOf(files),
        git: null,
      });
      continue;
    }

    const manifest = await readManifest(pluginPath);
    const entries = await resolveEntries(pluginPath, manifest);
    // A folder with nothing Pi would load is not a plugin. Without this, every
    // stray directory in the plugin folder shows up as a failed plugin.
    if (entries.length === 0) continue;

    const files = await walkPluginFiles(pluginPath);
    const mtime = newestMtime(files);
    plugins.push({
      id: entry.name,
      path: pluginPath,
      kind: "directory",
      name: manifest.name ?? entry.name,
      version: manifest.version,
      description: manifest.description,
      entries,
      dependencies: manifest.dependencies,
      enabled,
      override,
      status: enabled ? "unknown" : "disabled",
      errors: [],
      warnings: [],
      updatedAt: mtime === null ? null : new Date(mtime).toISOString(),
      revision: revisionOf(files),
      git: await readGitInfo(pluginPath),
    });
  }

  plugins.push(...(await discoverPackages(config)));
  plugins.sort((a, b) => a.id.localeCompare(b.id));
  knownRoots = plugins.map((plugin) => ({ id: plugin.id, path: plugin.path }));
  return plugins;
}

// ─── npm packages ────────────────────────────────────────────────────────────

/**
 * Where `npm install` puts plugin packages, inside the plugin directory.
 *
 * Pi's own layout (`<agentDir>/npm`), so a package installed here is the same
 * shape as one installed by `pi install`.
 */
export function npmInstallRoot(pluginsDir: string): string {
  return path.join(pluginsDir, ".pi", "npm");
}

/** Installed package directories. */
export function npmPackagesDir(pluginsDir: string): string {
  return path.join(npmInstallRoot(pluginsDir), "node_modules");
}

/** `@scope/name`, `name`, either with an `@version`; an `npm:` prefix is optional. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*(?:@[a-z0-9-._~^<>=*+|]+)?$/i;

const npmSourceSchema = z
  .string()
  .trim()
  .min(1, "Enter an npm package")
  .transform((value) => (value.startsWith("npm:") ? value.slice(4).trim() : value))
  .refine((value) => NPM_NAME.test(value), "Enter a package name, like npm:@scope/pi-usage");

/** The package name of a `name@version` spec, scope included. */
export function npmNameOf(source: string): string {
  const spec = source.replace(/^npm:/, "");
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * The `npm:` source to install, or a message saying why the input is not one.
 *
 * Anything that is not a bare package name would be passed to `npm install` as
 * a path or a URL, so it is rejected rather than run.
 */
export function normalizeNpmSource(input: string): string {
  return `npm:${npmSourceSchema.parse(input)}`;
}

/** A package manager scoped to the plugin directory, with no settings of its own. */
function pluginPackageManager(pluginsDir: string): DefaultPackageManager {
  return new DefaultPackageManager({
    cwd: pluginsDir,
    agentDir: path.join(pluginsDir, ".pi"),
    settingsManager: SettingsManager.inMemory(),
  });
}

/** Packages `npm install` recorded, i.e. the ones an admin asked for. */
async function installedPackageNames(pluginsDir: string): Promise<string[]> {
  const manifestPath = path.join(npmInstallRoot(pluginsDir), "package.json");
  try {
    const raw = await readFile(/*turbopackIgnore: true*/ manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, unknown> };
    return Object.keys(parsed.dependencies ?? {}).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Failed to read ${manifestPath}:`, err);
      recordPluginLog("warn", null, `Unreadable npm manifest: ${message(err)}`);
    }
    return [];
  }
}

/** The plugin an npm install produced, or a reason it is not one. */
async function packagePlugin(
  config: PluginConfig,
  id: string,
): Promise<{ plugin: PluginInfo } | { error: string }> {
  const pluginPath = path.join(npmPackagesDir(config.dir), id);
  if (!existsSync(/*turbopackIgnore: true*/ pluginPath)) {
    return { error: "installed, but missing from node_modules" };
  }
  const manifest = await readManifest(pluginPath);
  const entries = await resolveEntries(pluginPath, manifest, { allowIndexFile: false });
  if (entries.length === 0) return { error: "has no Pi extensions" };

  const files = await walkPluginFiles(pluginPath);
  const mtime = newestMtime(files);
  const override = config.states[id]?.enabled ?? null;
  return {
    plugin: {
      id,
      path: pluginPath,
      kind: "package",
      name: manifest.name ?? id,
      version: manifest.version,
      description: manifest.description,
      entries,
      dependencies: manifest.dependencies,
      enabled: config.enabled && override !== false,
      override,
      status: config.enabled && override !== false ? "unknown" : "disabled",
      errors: [],
      warnings: [],
      updatedAt: mtime === null ? null : new Date(mtime).toISOString(),
      revision: revisionOf(files),
      git: null,
    },
  };
}

/** Every npm-installed plugin, in name order. */
async function discoverPackages(config: PluginConfig): Promise<PluginInfo[]> {
  const plugins: PluginInfo[] = [];
  for (const id of await installedPackageNames(config.dir)) {
    const result = await packagePlugin(config, id);
    if ("error" in result) {
      recordPluginLog("warn", id, `Not loaded: ${result.error}`);
      continue;
    }
    plugins.push(result.plugin);
  }
  return plugins;
}

/**
 * Install an npm package into the plugin directory.
 *
 * Returns the plugin, or throws with a message worth showing an admin. A
 * package that turns out to carry no Pi extension is removed again, so the
 * directory never holds something that would load into every session.
 */
export async function installNpmPlugin(input: string): Promise<PluginInfo> {
  const config = await readPluginConfig();
  const source = normalizeNpmSource(input);
  const id = npmNameOf(source);

  await mkdir(path.join(config.dir, ".pi"), { recursive: true });
  recordPluginLog("info", id, `Installing ${source}`);
  try {
    await pluginPackageManager(config.dir).install(source);
  } catch (err) {
    console.error(`npm install ${source} failed:`, err);
    recordPluginLog("error", id, `Install failed: ${message(err)}`);
    throw new Error(`npm could not install ${source}`);
  }
  invalidatePluginCache();

  const result = await packagePlugin(config, id);
  if ("error" in result) {
    await pluginPackageManager(config.dir)
      .remove(source)
      .catch((err) => {
        console.error(`Failed to roll back ${source}:`, err);
      });
    recordPluginLog("error", id, `Not a Pi plugin: ${result.error}`);
    throw new Error(`${id} ${result.error}`);
  }

  recordPluginLog("info", id, `Installed ${id} v${result.plugin.version ?? "?"}`);
  return result.plugin;
}

/** Remove an npm-installed plugin. Folders and files are managed on disk. */
export async function removeNpmPlugin(id: string): Promise<void> {
  const config = await readPluginConfig();
  if (!(await installedPackageNames(config.dir)).includes(id)) {
    throw new Error(`${id} is not an npm-installed plugin`);
  }
  recordPluginLog("info", id, `Removing ${id}`);
  try {
    await pluginPackageManager(config.dir).remove(`npm:${id}`);
  } catch (err) {
    console.error(`npm uninstall ${id} failed:`, err);
    recordPluginLog("error", id, `Uninstall failed: ${message(err)}`);
    throw new Error(`npm could not remove ${id}`);
  }
  invalidatePluginCache();
}

/** The newest published version of a package, or `null` when npm cannot say. */
export async function npmLatestVersion(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", name, "version", "--json"], {
      timeout: 20_000,
      windowsHide: true,
    });
    const parsed: unknown = JSON.parse(stdout.trim());
    return typeof parsed === "string" ? parsed : null;
  } catch (err) {
    console.error(`npm view ${name} failed:`, err);
    return null;
  }
}

/**
 * Positive when `a` is the newer version.
 *
 * Only what a release tag needs: dotted numbers, and a prerelease (`-beta.1`)
 * sorting below the release it precedes.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore = "", aPre] = a.split("-", 2);
  const [bCore = "", bPre] = b.split("-", 2);
  const aParts = aCore.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bParts = bCore.split(".").map((part) => Number.parseInt(part, 10) || 0);

  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre === bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  return aPre.localeCompare(bPre, undefined, { numeric: true });
}

// ─── Load state ──────────────────────────────────────────────────────────────

export interface PluginDiagnostic {
  path: string;
  message: string;
}

/**
 * Load the given paths in a throwaway loader and report what Pi made of them.
 *
 * This runs each plugin's factory, exactly as a session would, so a plugin that
 * cannot load shows up as an error here instead of in a chat.
 */
export async function loadPluginDiagnostics(
  paths: readonly string[],
): Promise<{ errors: PluginDiagnostic[]; warnings: PluginDiagnostic[] }> {
  if (paths.length === 0) return { errors: [], warnings: [] };
  try {
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      settingsManager: createSessionSettings(),
      additionalExtensionPaths: [...paths],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      appendSystemPrompt: [],
    });
    await loader.reload();
    const result = loader.getExtensions();
    return {
      errors: (result.errors ?? []).map((entry) => ({ path: entry.path, message: entry.error })),
      warnings: (result.warnings ?? []).map((entry) => ({
        path: entry.path,
        message: entry.warning,
      })),
    };
  } catch (err) {
    console.error("Failed to inspect global Pi plugins:", err);
    return { errors: [{ path: "", message: message(err) }], warnings: [] };
  }
}

export interface PluginListResult {
  config: {
    dir: string;
    dirSetting: string;
    enabled: boolean;
    /** Whether a plugin may open a dialog through `ctx.ui`. */
    ui: boolean;
    dirExists: boolean;
  };
  plugins: PluginInfo[];
  /** Loader errors that name no plugin, so they belong to the set as a whole. */
  diagnostics: string[];
}

/** Every plugin with its current load state. */
export async function listPlugins(): Promise<PluginListResult> {
  const config = await readPluginConfig();
  const plugins = await discoverPlugins(config);
  const enabledPaths = plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.path);
  const diagnostics = await loadPluginDiagnostics(enabledPaths);
  // The page load is a load attempt like any other, so its failures belong in
  // the log an admin can look at later.
  recordExtensionDiagnostics({
    errors: diagnostics.errors.map((entry) => ({ path: entry.path, error: entry.message })),
    warnings: diagnostics.warnings.map((entry) => ({ path: entry.path, warning: entry.message })),
  });

  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    plugin.errors = diagnostics.errors
      .filter((entry) => pluginIdForPath(entry.path) === plugin.id)
      .map((entry) => entry.message);
    plugin.warnings = diagnostics.warnings
      .filter((entry) => pluginIdForPath(entry.path) === plugin.id)
      .map((entry) => entry.message);
    plugin.status = plugin.errors.length > 0 ? "error" : "loaded";
  }

  return {
    config: {
      dir: config.dir,
      dirSetting: config.dirSetting,
      enabled: config.enabled,
      ui: config.ui,
      dirExists: existsSync(/*turbopackIgnore: true*/ config.dir),
    },
    plugins,
    diagnostics: diagnostics.errors
      .filter((entry) => !pluginIdForPath(entry.path))
      .map((entry) => entry.message),
  };
}

// ─── Session paths ───────────────────────────────────────────────────────────

const PATHS_TTL_MS = 2_000;
let cachedPaths: { at: number; paths: string[] } | null = null;

/** Drop the cached path list, so the next session picks a change up at once. */
export function invalidatePluginCache(): void {
  cachedPaths = null;
}

/**
 * Plugin paths a session loads. Empty when plugins are off or unreadable.
 *
 * A broken setting must never fail a session: the reason is logged instead.
 */
export async function globalPluginPaths(): Promise<string[]> {
  const now = Date.now();
  if (cachedPaths && now - cachedPaths.at < PATHS_TTL_MS) return cachedPaths.paths;

  try {
    const config = await readPluginConfig();
    const plugins = await discoverPlugins(config);
    const paths = plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.path);
    cachedPaths = { at: now, paths };
    return paths;
  } catch (err) {
    console.error("Failed to resolve global Pi plugins:", err);
    recordPluginLog("error", null, `Could not read the plugin settings: ${message(err)}`);
    cachedPaths = { at: now, paths: [] };
    return [];
  }
}

// ─── Git: installed version and updates ──────────────────────────────────────

async function git(root: string, args: readonly string[], timeout = 5_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    console.error(`git ${args.join(" ")} failed in ${root}:`, err);
    return null;
  }
}

/** The checked-out commit, when the plugin is a git checkout. */
export async function readGitInfo(root: string): Promise<PluginGitInfo | null> {
  if (!existsSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, ".git"))) {
    return null;
  }
  const commit = await git(root, ["rev-parse", "--short", "HEAD"]);
  if (!commit) return null;
  const [branch, commitDate, status] = await Promise.all([
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["log", "-1", "--format=%cI"]),
    git(root, ["status", "--porcelain", "--untracked-files=no"]),
  ]);
  return {
    branch: branch && branch !== "HEAD" ? branch : null,
    commit,
    commitDate: commitDate || null,
    dirty: Boolean(status),
  };
}

export interface PluginUpdate {
  id: string;
  /** The branch or remote ref the checkout follows, or the npm registry. */
  upstream: string | null;
  /** Commits the upstream has that the checkout does not. Git checkouts only. */
  behind: number | null;
  /** The newest published version. npm packages only. */
  latest: string | null;
  /** Whether the upstream has something newer than what is installed. */
  outdated: boolean;
  error: string | null;
}

/**
 * Fetch each git-backed plugin and report how far behind it is.
 *
 * Network calls happen here and only here, on an explicit admin action.
 */
export async function checkPluginUpdates(): Promise<PluginUpdate[]> {
  const config = await readPluginConfig();
  const plugins = await discoverPlugins(config);
  const updates: PluginUpdate[] = [];

  for (const plugin of plugins) {
    if (plugin.kind === "package") {
      const latest = await npmLatestVersion(plugin.name);
      const outdated =
        latest !== null && plugin.version !== null && compareVersions(latest, plugin.version) > 0;
      updates.push({
        id: plugin.id,
        upstream: "npm",
        behind: null,
        latest,
        outdated,
        error: latest === null ? "npm did not answer" : null,
      });
      continue;
    }

    if (
      plugin.kind !== "directory" ||
      !existsSync(
        /*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ plugin.path, ".git"),
      )
    ) {
      continue;
    }

    const fetched = await git(plugin.path, ["fetch", "--quiet", "--prune"], 20_000);
    if (fetched === null) {
      updates.push({
        id: plugin.id,
        upstream: null,
        behind: null,
        latest: null,
        outdated: false,
        error: "git fetch failed",
      });
      continue;
    }

    const upstream = await git(plugin.path, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    if (!upstream) {
      updates.push({
        id: plugin.id,
        upstream: null,
        behind: null,
        latest: null,
        outdated: false,
        error: "No upstream branch",
      });
      continue;
    }

    const count = await git(plugin.path, ["rev-list", "--count", `HEAD..${upstream}`]);
    const behind = count === null ? null : Number.parseInt(count, 10);
    updates.push({
      id: plugin.id,
      upstream,
      behind: Number.isFinite(behind) ? behind : null,
      latest: null,
      outdated: behind !== null && behind > 0,
      error: behind === null ? "Could not compare with upstream" : null,
    });
  }

  return updates;
}

// ─── Log ─────────────────────────────────────────────────────────────────────

export type PluginLogLevel = "info" | "warn" | "error";

export interface PluginLogEntry {
  id: number;
  at: string;
  level: PluginLogLevel;
  pluginId: string | null;
  message: string;
}

const LOG_LIMIT = 300;
let logSeq = 0;
const logEntries: PluginLogEntry[] = [];

/**
 * Record one line. An identical repeat of the newest line is dropped: a plugin
 * that fails on every session build would otherwise bury everything else.
 */
export function recordPluginLog(
  level: PluginLogLevel,
  pluginId: string | null,
  text: string,
): void {
  const newest = logEntries[0];
  if (newest && newest.level === level && newest.pluginId === pluginId && newest.message === text) {
    return;
  }
  logSeq += 1;
  logEntries.unshift({
    id: logSeq,
    at: new Date().toISOString(),
    level,
    pluginId,
    message: text,
  });
  if (logEntries.length > LOG_LIMIT) logEntries.length = LOG_LIMIT;
}

/** Newest first. */
export function pluginLogEntries(): PluginLogEntry[] {
  return [...logEntries];
}

export function clearPluginLog(): void {
  logEntries.length = 0;
}

/** Log a loader result. Used for every session build, so the log stays live. */
export function recordExtensionDiagnostics(result: {
  errors?: ReadonlyArray<{ path: string; error: string }>;
  warnings?: ReadonlyArray<{ path: string; warning: string }>;
}): void {
  for (const entry of result.errors ?? []) {
    recordPluginLog("error", pluginIdForPath(entry.path), diagnosticText(entry.path, entry.error));
  }
  for (const entry of result.warnings ?? []) {
    recordPluginLog("warn", pluginIdForPath(entry.path), diagnosticText(entry.path, entry.warning));
  }
}

/** `file.ts: message`, or just the message when the path is the plugin itself. */
function diagnosticText(filePath: string, text: string): string {
  const name = path.basename(filePath);
  const pluginId = pluginIdForPath(filePath);
  // A package root is `@scope/name`; its folder name is only the last part.
  if (!name || !pluginId || name === pluginId || pluginId.endsWith(`/${name}`)) return text;
  return `${name}: ${text}`;
}
