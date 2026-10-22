/**
 * Global Pi plugins: discovery, switches, load state and the log.
 *
 * The load-state tests point the real loader at a temp directory, so a plugin
 * that cannot load is proven to surface as an error rather than as a broken
 * session.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findAdminSettings: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { adminSettings: { findUnique: mocks.findAdminSettings } },
}));

import {
  checkPluginUpdates,
  clearPluginLog,
  compareVersions,
  defaultPluginsDir,
  discoverPlugins,
  globalPluginPaths,
  installNpmPlugin,
  invalidatePluginCache,
  listPlugins,
  normalizeNpmSource,
  npmInstallRoot,
  npmNameOf,
  pluginIdForPath,
  pluginLogEntries,
  readGitInfo,
  recordPluginLog,
  removeNpmPlugin,
  resolvePluginsDir,
  type PluginConfig,
} from "@/lib/pi/plugins";
import { normalizePluginStates } from "@/lib/settings/properties";

let root: string;

async function writeFile(relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

/** A working plugin: an index.ts whose factory registers nothing. */
const GOOD_PLUGIN = `export default function () {}\n`;
/** A plugin whose module throws while it is being imported. */
const BROKEN_PLUGIN = `throw new Error("boom from the plugin");\nexport default function () {}\n`;

/** alpha/ (package.json + ext.ts), beta/ (index.ts), gamma.ts, plus noise. */
async function seedDirectory(): Promise<void> {
  await writeFile(
    "alpha/package.json",
    JSON.stringify({
      name: "alpha-plugin",
      version: "1.2.3",
      description: "Adds a thing",
      dependencies: { "left-pad": "^1.0.0" },
      pi: { extensions: ["./ext.ts"] },
    }),
  );
  await writeFile("alpha/ext.ts", GOOD_PLUGIN);

  await writeFile("beta/index.ts", GOOD_PLUGIN);

  await writeFile("gamma.ts", GOOD_PLUGIN);

  // Nothing here is a plugin.
  await writeFile("notes.md", "readme");
  await writeFile(".hidden/index.ts", GOOD_PLUGIN);
  await writeFile("node_modules/pkg/index.ts", GOOD_PLUGIN);
}

function config(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    dir: root,
    dirSetting: root,
    enabled: true,
    states: {},
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.findAdminSettings.mockResolvedValue(null);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "saale-plugins-"));
  invalidatePluginCache();
  clearPluginLog();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.PI_GLOBAL_PLUGINS_DIR;
});

describe("resolvePluginsDir", () => {
  it("prefers the admin setting, resolved to an absolute path", () => {
    process.env.PI_GLOBAL_PLUGINS_DIR = "/env/plugins";
    expect(resolvePluginsDir(" relative/dir ")).toBe(path.resolve("relative/dir"));
  });

  it("falls back to the environment, then the uploads volume", () => {
    process.env.PI_GLOBAL_PLUGINS_DIR = "/env/plugins";
    expect(resolvePluginsDir("")).toBe(path.resolve("/env/plugins"));
    expect(resolvePluginsDir(null)).toBe(path.resolve("/env/plugins"));

    delete process.env.PI_GLOBAL_PLUGINS_DIR;
    expect(resolvePluginsDir("")).toBe(defaultPluginsDir());
    expect(defaultPluginsDir().endsWith(path.join("uploads", "pi_plugins"))).toBe(true);
  });
});

describe("normalizePluginStates", () => {
  it("keeps only the plugins switched off", () => {
    expect(
      normalizePluginStates({
        off: { enabled: false },
        on: { enabled: true },
        broken: { enabled: "yes" },
        empty: null,
        "": { enabled: false },
      }),
    ).toEqual({ off: { enabled: false } });
  });

  it("reads anything that is not an object as no overrides", () => {
    expect(normalizePluginStates(null)).toEqual({});
    expect(normalizePluginStates(["off"])).toEqual({});
  });
});

describe("discoverPlugins", () => {
  it("finds directories and single files, and skips everything else", async () => {
    await seedDirectory();

    const plugins = await discoverPlugins(config());

    expect(plugins.map((plugin) => plugin.id)).toEqual(["alpha", "beta", "gamma.ts"]);
    expect(plugins.every((plugin) => plugin.enabled)).toBe(true);
    expect(plugins.every((plugin) => plugin.override === null)).toBe(true);
  });

  it("reads a plugin's manifest, entries and dependencies", async () => {
    await seedDirectory();

    const [alpha, beta, gamma] = await discoverPlugins(config());

    expect(alpha).toMatchObject({
      kind: "directory",
      name: "alpha-plugin",
      version: "1.2.3",
      description: "Adds a thing",
      entries: ["./ext.ts"],
      dependencies: ["left-pad"],
    });
    // No manifest: Pi falls back to index.ts.
    expect(beta).toMatchObject({ kind: "directory", name: "beta", entries: ["index.ts"] });
    expect(gamma).toMatchObject({ kind: "file", entries: ["gamma.ts"] });
  });

  it("discovers an extensions/ folder and reports a change in revision", async () => {
    await writeFile("delta/extensions/one.ts", GOOD_PLUGIN);
    await writeFile("delta/extensions/two.ts", GOOD_PLUGIN);

    const [delta] = await discoverPlugins(config());
    expect(delta?.entries).toEqual([
      path.join("extensions", "one.ts"),
      path.join("extensions", "two.ts"),
    ]);

    const before = delta?.revision;
    await writeFile("delta/extensions/three.ts", GOOD_PLUGIN);
    const [changed] = await discoverPlugins(config());
    expect(changed?.revision).not.toBe(before);
  });

  it("applies the master switch and the per-plugin switch separately", async () => {
    await seedDirectory();

    const switchedOff = await discoverPlugins(config({ states: { beta: { enabled: false } } }));
    expect(switchedOff.map((plugin) => [plugin.id, plugin.enabled, plugin.override])).toEqual([
      ["alpha", true, null],
      ["beta", false, false],
      ["gamma.ts", true, null],
    ]);

    const masterOff = await discoverPlugins(config({ enabled: false }));
    expect(masterOff.every((plugin) => !plugin.enabled)).toBe(true);
    expect(masterOff.every((plugin) => plugin.status === "disabled")).toBe(true);
  });

  it("skips a folder with nothing Pi would load", async () => {
    await writeFile("assets/logo.svg", "<svg />");
    await writeFile("assets/README.md", "not a plugin");

    expect(await discoverPlugins(config())).toEqual([]);
  });

  it("returns nothing for a directory that does not exist", async () => {
    expect(await discoverPlugins(config({ dir: path.join(root, "nope") }))).toEqual([]);
    expect(pluginLogEntries()).toEqual([]);
  });
});

describe("pluginIdForPath", () => {
  it("attributes a file to the plugin that contains it", async () => {
    await seedDirectory();
    await discoverPlugins(config());

    expect(pluginIdForPath(path.join(root, "alpha", "ext.ts"))).toBe("alpha");
    expect(pluginIdForPath(path.join(root, "beta", "index.ts"))).toBe("beta");
    expect(pluginIdForPath("/elsewhere/index.ts")).toBeNull();
    expect(pluginIdForPath(null)).toBeNull();
  });
});

describe("globalPluginPaths", () => {
  it("returns the enabled plugin paths and honours the master switch", async () => {
    await seedDirectory();
    mocks.findAdminSettings.mockResolvedValue({
      piPluginsDir: root,
      piPluginsEnabled: true,
      piPluginStates: { beta: { enabled: false } },
    });

    expect(await globalPluginPaths()).toEqual([
      path.join(root, "alpha"),
      path.join(root, "gamma.ts"),
    ]);

    invalidatePluginCache();
    mocks.findAdminSettings.mockResolvedValue({
      piPluginsDir: root,
      piPluginsEnabled: false,
      piPluginStates: null,
    });
    expect(await globalPluginPaths()).toEqual([]);
  });

  it("caches the paths until the cache is invalidated", async () => {
    await seedDirectory();
    mocks.findAdminSettings.mockResolvedValue({
      piPluginsDir: root,
      piPluginsEnabled: true,
      piPluginStates: null,
    });

    await globalPluginPaths();
    mocks.findAdminSettings.mockResolvedValue({
      piPluginsDir: root,
      piPluginsEnabled: true,
      piPluginStates: { alpha: { enabled: false } },
    });

    // Same answer from the cache, without a second read.
    expect(await globalPluginPaths()).toEqual([
      path.join(root, "alpha"),
      path.join(root, "beta"),
      path.join(root, "gamma.ts"),
    ]);
    invalidatePluginCache();
    expect(await globalPluginPaths()).toEqual([
      path.join(root, "beta"),
      path.join(root, "gamma.ts"),
    ]);
  });

  it("loads no plugins when the settings cannot be read, and says why", async () => {
    mocks.findAdminSettings.mockRejectedValue(new Error("database is down"));

    expect(await globalPluginPaths()).toEqual([]);
    const log = pluginLogEntries();
    expect(log[0]).toMatchObject({ level: "error", pluginId: null });
    expect(log[0]?.message).toContain("database is down");
  });
});

describe("listPlugins", () => {
  it("reports a plugin that loads and one that cannot", async () => {
    await writeFile("good/index.ts", GOOD_PLUGIN);
    await writeFile("bad/index.ts", BROKEN_PLUGIN);
    mocks.findAdminSettings.mockResolvedValue({
      piPluginsDir: root,
      piPluginsEnabled: true,
      piPluginStates: null,
    });

    const result = await listPlugins();
    const good = result.plugins.find((plugin) => plugin.id === "good");
    const bad = result.plugins.find((plugin) => plugin.id === "bad");

    expect(good?.status).toBe("loaded");
    expect(good?.errors).toEqual([]);
    expect(bad?.status).toBe("error");
    expect(bad?.errors.join(" ")).toContain("boom from the plugin");
    expect(result.config).toMatchObject({ dir: root, enabled: true, dirExists: true });
  });

  it("does not load a plugin that is switched off", async () => {
    await writeFile("bad/index.ts", BROKEN_PLUGIN);
    mocks.findAdminSettings.mockResolvedValue({
      piPluginsDir: root,
      piPluginsEnabled: true,
      piPluginStates: { bad: { enabled: false } },
    });

    const result = await listPlugins();
    expect(result.plugins[0]?.status).toBe("disabled");
    expect(result.plugins[0]?.errors).toEqual([]);
  });

  it("reports a directory that is not there", async () => {
    mocks.findAdminSettings.mockResolvedValue({
      piPluginsDir: path.join(root, "missing"),
      piPluginsEnabled: true,
      piPluginStates: null,
    });

    const result = await listPlugins();
    expect(result.plugins).toEqual([]);
    expect(result.config.dirExists).toBe(false);
  });
});

describe("git", () => {
  it("reports no git info for a plain directory", async () => {
    expect(await readGitInfo(root)).toBeNull();
  });

  it("checks nothing when no plugin is a git checkout", async () => {
    await seedDirectory();
    mocks.findAdminSettings.mockResolvedValue({
      piPluginsDir: root,
      piPluginsEnabled: true,
      piPluginStates: null,
    });

    expect(await checkPluginUpdates()).toEqual([]);
  });
});

describe("npm sources", () => {
  it("accepts a name, a scope and a version, with or without the npm prefix", () => {
    expect(normalizeNpmSource("npm:@narumitw/pi-usage")).toBe("npm:@narumitw/pi-usage");
    expect(normalizeNpmSource(" @narumitw/pi-usage@1.2.3 ")).toBe("npm:@narumitw/pi-usage@1.2.3");
    expect(normalizeNpmSource("pi-usage")).toBe("npm:pi-usage");
    expect(normalizeNpmSource("npm:pi-usage@latest")).toBe("npm:pi-usage@latest");
  });

  it("refuses anything npm would treat as a path or a URL", () => {
    for (const input of ["", "  ", "../evil", "name with space", "https://example.com/x.tgz"]) {
      expect(() => normalizeNpmSource(input)).toThrow();
    }
  });

  it("reads the package name out of a spec", () => {
    expect(npmNameOf("npm:@narumitw/pi-usage@1.2.3")).toBe("@narumitw/pi-usage");
    expect(npmNameOf("npm:pi-usage")).toBe("pi-usage");
    expect(npmNameOf("npm:pi-usage@^2.0.0")).toBe("pi-usage");
  });
});

describe("compareVersions", () => {
  it("orders releases by their numbers", () => {
    expect(compareVersions("1.2.3", "1.2.2")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
  });

  it("sorts a prerelease below the release it precedes", () => {
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
  });
});

describe("npm-installed plugins", () => {
  /** `<dir>/.pi/npm` with `dependencies`, plus the package directories. */
  async function seedPackage(
    name: string,
    manifest: Record<string, unknown>,
    files: Record<string, string> = { "dist/index.js": GOOD_PLUGIN },
  ): Promise<void> {
    await writeFile(
      path.join(".pi", "npm", "package.json"),
      JSON.stringify({ name: "pi-extensions", dependencies: { [name]: "^1.0.0" } }),
    );
    await writeFile(
      path.join(".pi", "npm", "node_modules", name, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...manifest }),
    );
    for (const [relative, content] of Object.entries(files)) {
      await writeFile(path.join(".pi", "npm", "node_modules", name, relative), content);
    }
  }

  it("discovers a package that declares Pi extensions", async () => {
    await seedPackage("@narumitw/pi-usage", {
      description: "Token usage",
      pi: { extensions: ["dist/index.js"] },
    });

    const plugins = await discoverPlugins(config());
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      id: "@narumitw/pi-usage",
      kind: "package",
      name: "@narumitw/pi-usage",
      version: "1.0.0",
      description: "Token usage",
      entries: ["dist/index.js"],
      enabled: true,
      git: null,
    });
    expect(
      pluginIdForPath(
        path.join(npmInstallRoot(root), "node_modules/@narumitw/pi-usage/dist/index.js"),
      ),
    ).toBe("@narumitw/pi-usage");
  });

  it("ignores a dependency that only ships an index.js", async () => {
    await seedPackage("left-pad", {}, { "index.js": "module.exports = () => {};\n" });

    expect(await discoverPlugins(config())).toEqual([]);
    expect(pluginLogEntries()[0]?.message).toContain("no Pi extensions");
  });

  it("finds a package's extensions/ folder", async () => {
    await seedPackage(
      "pi-tools",
      {},
      { "extensions/one.ts": GOOD_PLUGIN, "extensions/two.ts": GOOD_PLUGIN },
    );

    const [plugin] = await discoverPlugins(config());
    expect(plugin?.entries).toEqual([
      path.join("extensions", "one.ts"),
      path.join("extensions", "two.ts"),
    ]);
  });

  it("honours the switches by package name", async () => {
    await seedPackage("pi-usage", { pi: { extensions: ["dist/index.js"] } });

    const [off] = await discoverPlugins(config({ states: { "pi-usage": { enabled: false } } }));
    expect(off).toMatchObject({ enabled: false, override: false, status: "disabled" });
  });

  it("refuses a spec before npm is ever run", async () => {
    await expect(installNpmPlugin("../evil")).rejects.toThrow();
  });

  it("refuses to remove a plugin that npm did not install", async () => {
    await seedDirectory();
    await expect(removeNpmPlugin("alpha")).rejects.toThrow("not an npm-installed plugin");
  });
});

describe("plugin log", () => {
  it("keeps the newest first and drops a repeat of the last line", () => {
    recordPluginLog("info", "alpha", "loaded");
    recordPluginLog("info", "alpha", "loaded");
    recordPluginLog("error", "beta", "threw");

    expect(pluginLogEntries().map((entry) => entry.message)).toEqual(["threw", "loaded"]);

    clearPluginLog();
    expect(pluginLogEntries()).toEqual([]);
  });

  it("caps the log", () => {
    for (let index = 0; index < 400; index += 1) {
      recordPluginLog("warn", "alpha", `line ${index}`);
    }
    const log = pluginLogEntries();
    expect(log.length).toBe(300);
    expect(log[0]?.message).toBe("line 399");
  });
});
