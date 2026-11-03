/**
 * Fails when `src/` imports a package that a production install does not carry.
 *
 * `next build` compiles against the full tree, so a runtime import declared in
 * `devDependencies` builds fine and only dies inside the deployed image. This
 * links the dependencies the way the image does and checks every import against it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const SOURCE_DIR = "src";
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;
const APP_ALIAS = /^@\//;

/** @param {string} dir */
function collectSources(dir) {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSources(rel));
    else if (SOURCE_FILE.test(entry.name)) files.push(rel);
  }
  return files;
}

/**
 * Package name of a bare specifier, or null for relative paths, app aliases and
 * node builtins.
 * @param {string} specifier
 */
function packageOf(specifier) {
  if (specifier.startsWith(".") || APP_ALIAS.test(specifier)) return null;
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  if (builtinModules.includes(bare.split("/")[0])) return null;
  return bare.startsWith("@") ? bare.split("/").slice(0, 2).join("/") : bare.split("/")[0];
}

const importers = new Map();
for (const file of collectSources(SOURCE_DIR)) {
  const source = ts.preProcessFile(fs.readFileSync(path.join(root, file), "utf8"), true, true);
  for (const { fileName } of source.importedFiles) {
    const pkg = packageOf(fileName);
    if (!pkg) continue;
    if (!importers.has(pkg)) importers.set(pkg, []);
    importers.get(pkg).push(file);
  }
}

const target = fs.mkdtempSync(path.join(os.tmpdir(), "saale-prod-deps-"));
for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  fs.copyFileSync(path.join(root, file), path.join(target, file));
}
fs.cpSync(path.join(root, "patches"), path.join(target, "patches"), { recursive: true });

const install = spawnSync(
  "pnpm",
  ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--reporter=append-only"],
  { cwd: target, stdio: "inherit" },
);
if (install.status !== 0) {
  console.error(`Failed to install the production tree in ${target}`);
  process.exit(1);
}

const missing = [...importers.keys()].filter(
  (pkg) => !fs.existsSync(path.join(target, "node_modules", pkg)),
);
fs.rmSync(target, { recursive: true, force: true });

if (missing.length === 0) {
  process.stdout.write(
    `All ${importers.size} packages imported by ${SOURCE_DIR}/ are in the production tree.\n`,
  );
  process.exit(0);
}

for (const pkg of missing) {
  console.error(
    `${pkg} is imported by ${[...new Set(importers.get(pkg))].join(", ")} but missing after a --prod install`,
  );
}
process.exit(1);
