import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The client boundary.
 *
 * A `"use client"` module and everything it imports is bundled for the browser,
 * so a chain that reaches `@/lib/db` or a node builtin fails the production
 * build with "Module not found: Can't resolve 'fs'". The build is the last place
 * that can happen, and it says nothing about which import to cut.
 *
 * This walks the import graph from every client entry and names the chain. It
 * reads the source, so a new file is covered without being registered here.
 */

const SRC = join(__dirname, "..", "src");

/** Modules a browser bundle cannot carry, whatever imports them. */
const SERVER_ONLY = new Set(["@/lib/db"]);

/** Node builtins a client chain must never name. */
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

const EXTENSIONS = [".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"];

interface Module {
  /** Path from the repository root, the way a failure reads a chain. */
  path: string;
  /** Whether the file opens with the client directive. */
  client: boolean;
  /** Every module specifier it loads at runtime. */
  imports: string[];
}

/** The source with comments taken out, so a doc comment cannot look like an import. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Whether a statement imports names for the type checker alone. */
function isTypeOnly(statement: string): boolean {
  if (/^import\s+type\b/.test(statement)) return true;
  const braces = /\{([\s\S]*?)\}/.exec(statement);
  if (!braces) return false;
  const names = (braces[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => name.startsWith("type "));
}

/** The module specifiers a file loads at runtime. */
function importsOf(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];

  for (const statement of code.match(/\b(?:import|export)\b[^;]*;/g) ?? []) {
    const specifier = /["']([^"']+)["']\s*;?\s*$/.exec(statement)?.[1];
    if (!specifier || isTypeOnly(statement)) continue;
    found.push(specifier);
  }
  for (const match of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const specifier = match[1];
    if (specifier) found.push(specifier);
  }

  return found;
}

function isClientEntry(source: string): boolean {
  return /^\s*["']use client["']\s*;?/.test(stripComments(source));
}

/** Every file under `src`, keyed by path from the repository root. */
function readSource(): Map<string, Module> {
  const modules = new Map<string, Module>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|mts|js|mjs)$/.test(entry)) continue;
      const source = readFileSync(path, "utf8");
      modules.set(relative(join(__dirname, ".."), path).split(sep).join("/"), {
        path: relative(join(__dirname, ".."), path).split(sep).join("/"),
        client: isClientEntry(source),
        imports: importsOf(source),
      });
    }
  };
  walk(SRC);
  return modules;
}

/** The file a specifier names, or null for a package, an asset or a missing file. */
function resolveSpecifier(
  specifier: string,
  from: string,
  modules: Map<string, Module>,
): string | null {
  const base = specifier.startsWith("@/")
    ? `src/${specifier.slice(2)}`
    : specifier.startsWith(".")
      ? relative(join(__dirname, ".."), resolve(join(__dirname, ".."), dirname(from), specifier))
          .split(sep)
          .join("/")
      : null;
  if (!base || base.startsWith("..")) return null;

  const candidates = [base, ...EXTENSIONS.map((extension) => `${base}${extension}`)];
  return candidates.find((candidate) => modules.has(candidate)) ?? null;
}

/** Why a specifier cannot reach the browser, or null when it can. */
function forbiddenReason(specifier: string): string | null {
  if (SERVER_ONLY.has(specifier)) return specifier;
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return NODE_BUILTINS.has(bare) ? bare : null;
}

/**
 * The shortest chain from `entry` to something the browser cannot hold, or null
 * when the entry is safe.
 */
function offendingChain(
  entry: string,
  modules: Map<string, Module>,
): { chain: string[]; reason: string } | null {
  const seen = new Set([entry]);
  const queue: { path: string; chain: string[] }[] = [{ path: entry, chain: [entry] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const currentModule = modules.get(current.path);
    if (!currentModule) continue;

    for (const specifier of currentModule.imports) {
      const reason = forbiddenReason(specifier);
      if (reason) return { chain: [...current.chain, specifier], reason };

      const next = resolveSpecifier(specifier, current.path, modules);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      queue.push({ path: next, chain: [...current.chain, next] });
    }
  }

  return null;
}

describe("the import scanner", () => {
  it("finds imports, exports and dynamic imports", () => {
    const imports = importsOf(`
      "use client";
      import { Button } from "@/components/ui/button";
      import "./side-effect";
      export { thing } from "./thing";
      const lazy = () => import("@/lib/lazy");
      // import { hidden } from "./commented-out";
    `);
    expect(imports).toEqual(["@/components/ui/button", "./side-effect", "./thing", "@/lib/lazy"]);
  });

  it("leaves what the type checker alone imports out of the graph", () => {
    const imports = importsOf(`
      import type { AdminSettings } from "@prisma/client";
      import { type Foo, type Bar } from "@/lib/types";
      import { keep, type Dropped } from "@/lib/mixed";
    `);
    expect(imports).toEqual(["@/lib/mixed"]);
  });

  it("names a client entry by its directive", () => {
    expect(isClientEntry('"use client";\nimport x from "y";')).toBe(true);
    expect(isClientEntry("// a note\n'use client';\nexport {};")).toBe(true);
    expect(isClientEntry('import x from "y";\n"use client";')).toBe(false);
  });

  it("follows a chain to the module that breaks the bundle", () => {
    const modules = new Map<string, Module>([
      ["src/browser.tsx", { path: "src/browser.tsx", client: true, imports: ["./middle"] }],
      ["src/middle.ts", { path: "src/middle.ts", client: false, imports: ["@/lib/db"] }],
      ["src/lib/db.ts", { path: "src/lib/db.ts", client: false, imports: ["node:fs"] }],
    ]);
    expect(offendingChain("src/browser.tsx", modules)).toEqual({
      chain: ["src/browser.tsx", "src/middle.ts", "@/lib/db"],
      reason: "@/lib/db",
    });
  });

  it("finds nothing in a chain that stays in the browser", () => {
    const modules = new Map<string, Module>([
      ["src/browser.tsx", { path: "src/browser.tsx", client: true, imports: ["./util"] }],
      ["src/util.ts", { path: "src/util.ts", client: false, imports: ["@/lib/format"] }],
      ["src/lib/format.ts", { path: "src/lib/format.ts", client: false, imports: [] }],
    ]);
    expect(offendingChain("src/browser.tsx", modules)).toBeNull();
  });
});

describe("client modules", () => {
  const modules = readSource();
  const entries = [...modules.values()].filter((module) => module.client);

  it("has client entries to check", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("reach nothing the browser bundle cannot carry", () => {
    const offenders = entries
      .map((entry) => offendingChain(entry.path, modules))
      .filter((offending) => offending !== null)
      .map((offending) => offending.chain.join(" -> "));

    expect(
      offenders,
      "These client chains pull a server module into the browser bundle. Move the browser-safe part into a module of its own, or move the import behind the module that needs it.",
    ).toEqual([]);
  });
});
