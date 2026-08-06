#!/usr/bin/env node
/**
 * Bundle the Prisma CLI and its full dependency closure into a staging dir.
 *
 * Why: the production web image uses Next.js `output: "standalone"`, whose
 * tracer only includes modules imported by server code — the `prisma` CLI is
 * not traced, so `prisma migrate deploy` would otherwise be downloaded by
 * npx at container boot (needs network, slow, non-deterministic).
 *
 * This script walks the dependency graph of `prisma` in the installed
 * `node_modules` (resolving nested packages the way Node does) and copies the
 * closure into <output-dir>, preserving `node_modules`-relative paths. The
 * Dockerfile copies that staging dir into the production image's node_modules.
 *
 * Self-maintaining: run after every `npm install` — the closure is recomputed
 * from whatever prisma version the lockfile resolves to.
 *
 * Usage: node scripts/bundle-prisma-cli.mjs [output-dir]
 */
/* eslint-disable no-console */
import { readFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";

const root = process.cwd();
const nm = join(root, "node_modules");
const out = process.argv[2] ?? join(root, "prisma-cli-bundle");

/** Resolve a package dir the way Node does: nested node_modules first, then hoisted. */
function resolvePackage(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function depsOf(pkgDir) {
  const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  return { ...(pj.dependencies ?? {}), ...(pj.optionalDependencies ?? {}) };
}

const prismaDir = resolvePackage(root, "prisma");
if (!prismaDir) {
  console.error("prisma not found in node_modules — run `npm install` first");
  process.exit(1);
}

const seen = new Set();
const queue = [prismaDir];
while (queue.length) {
  const dir = queue.shift();
  if (seen.has(dir)) continue;
  seen.add(dir);
  for (const name of Object.keys(depsOf(dir))) {
    const depDir = resolvePackage(dir, name);
    if (depDir) queue.push(depDir);
  }
}

mkdirSync(out, { recursive: true });
for (const dir of seen) {
  if (!dir.startsWith(nm + "/")) {
    console.error(`Unexpected package location outside node_modules: ${dir}`);
    process.exit(1);
  }
  const rel = dir.slice(nm.length + 1);
  cpSync(dir, join(out, rel), { recursive: true });
}

console.log(`Bundled prisma CLI closure (${seen.size} packages) into ${out}`);
