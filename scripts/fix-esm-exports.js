#!/usr/bin/env node
/**
 * Postinstall fix: add a "default" export condition to ESM-only packages.
 *
 * tsx's CJS register hook cannot resolve packages that declare only an
 * "import" condition in their exports map — a `require()` of them fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. This script adds a "default" condition
 * pointing at the same file as "import", making them resolvable by both the CJS
 * and ESM loaders. Only packages matching PKG_PATTERN are touched.
 *
 * Why these: the app's .ts files are compiled to CJS by tsx (package.json has
 * no `"type": "module"`) and the worker runs through tsx in development.
 *   - @earendil-works/pi-*     — the agent SDK itself
 *   - jiti                     — `jiti/static`, pulled in by the same bundle
 *   - defuddle                 — `defuddle/node`, imported by the web-fetch tool
 * Production is unaffected: Docker installs with `--ignore-scripts` and runs
 * the esbuild-bundled ESM worker, where ESM resolution is never a problem.
 *
 * See: https://nodejs.org/api/packages.html#package-entry-points
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-console */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const PKG_PATTERN = /^(@earendil-works\/pi-[^/]+|jiti|defuddle)$/;
// Deep enough for nested copies of the packages above, shallow enough to skip
// walking the whole dependency tree.
const MAX_DEPTH = 6;

function fixExports(pkgPath) {
  // Most directories in node_modules are not packages or have no exports map.
  if (!fs.existsSync(pkgPath)) return;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (err) {
    console.error(`Could not parse ${pkgPath}:`, err);
    return;
  }
  if (!pkg.exports || !pkg.name?.match(PKG_PATTERN)) return;

  let changed = false;
  for (const val of Object.values(pkg.exports)) {
    if (typeof val === "object" && val !== null && val.import && !val.default) {
      val.default = val.import;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
    console.log(`  Fixed exports in ${pkg.name}`);
  }
}

/** readdir that yields an empty list instead of throwing. */
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    console.error(`Could not read ${dir}:`, err);
    return [];
  }
}

/**
 * Visit every package inside every nested node_modules, plus scoped packages.
 * Returns the number of package.json files inspected.
 */
function walk(dir, depth) {
  if (depth > MAX_DEPTH || !fs.existsSync(dir)) return 0;
  let inspected = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    console.error(`Could not read ${dir}:`, err);
    return 0;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry);
    let isDir;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch (err) {
      console.error(`Could not stat ${full}:`, err);
      continue;
    }
    if (!isDir) continue;

    if (entry.startsWith("@")) {
      // Scope directory — its children are packages.
      for (const scoped of safeReaddir(full)) {
        const pkgDir = path.join(full, scoped);
        fixExports(path.join(pkgDir, "package.json"));
        inspected++;
        inspected += walk(path.join(pkgDir, "node_modules"), depth + 1);
      }
      continue;
    }

    // Cache/tool directories (.bin, .cache, .vite, ...) hold no packages.
    if (entry.startsWith(".")) continue;
    fixExports(path.join(full, "package.json"));
    inspected++;
    inspected += walk(path.join(full, "node_modules"), depth + 1);
  }

  return inspected;
}

const nodeModules = path.join(root, "node_modules");
if (!fs.existsSync(nodeModules)) {
  console.log("No node_modules found, skipping fix-esm-exports");
  process.exit(0);
}

console.log("Fixing ESM exports for tsx compatibility...");
const inspected = walk(nodeModules, 0);
console.log(`Done (${inspected} packages inspected).`);
