#!/usr/bin/env node
/**
 * Postinstall fix: add "default" export condition to @earendil-works packages.
 *
 * tsx's CJS register hook cannot resolve ESM-only packages (those with only
 * "import" in their exports field, no "require" or "default"). This script
 * adds a "default" condition pointing to the same file as "import", making
 * them resolvable by both CJS and ESM loaders.
 *
 * See: https://nodejs.org/api/packages.html#package-entry-points
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-console, @typescript-eslint/no-unused-vars */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkgPattern = /@earendil-works\/pi-[^/]+/;

function fixExports(dir) {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (!pkg.exports || !pkg.name?.match(pkgPattern)) return;

  let changed = false;
  for (const [key, val] of Object.entries(pkg.exports)) {
    if (typeof val === "object" && val.import && !val.default) {
      val.default = val.import;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
    console.log(`  Fixed exports in ${pkg.name}`);
  }
}

const nm = path.join(root, "node_modules", "@earendil-works");
if (!fs.existsSync(nm)) {
  console.log("No @earendil-works packages found, skipping fix-esm-exports");
  process.exit(0);
}

console.log("Fixing ESM exports for tsx compatibility...");

// Top-level packages
for (const entry of fs.readdirSync(nm)) {
  fixExports(path.join(nm, entry));
}

// Nested packages (inside pi-coding-agent/node_modules, etc.)
function walk(dir, depth = 0) {
  if (depth > 4) return;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (!stat.isDirectory()) continue;
      if (entry === "node_modules") {
        for (const sub of fs.readdirSync(full)) {
          if (sub.startsWith("@earendil-works")) {
            for (const pkg of fs.readdirSync(path.join(full, sub))) {
              fixExports(path.join(full, sub, pkg));
            }
          }
        }
        walk(full, depth + 1);
      } else if (entry.startsWith("pi-") || entry.startsWith("@")) {
        // Also recurse into package directories (e.g., pi-coding-agent/)
        walk(full, depth + 1);
      }
    }
  } catch {
    // Skip unreadable directories
  }
}

walk(nm);
console.log("Done.");
