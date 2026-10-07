import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Share-surface redaction constraints.
 *
 * The share endpoints redact tool calls (see `@/lib/chat/redact-tool-calls`)
 * and the share viewer renders `RedactedToolCall`, so the two ways a future
 * change could put raw results on a public page are:
 *
 *   1. a new card — the share surface must not be able to reach one, and
 *   2. a new endpoint that serializes another user's `toolCalls`.
 *
 * Both are checked here by reading the source, so neither depends on anyone
 * re-running the audit. A new card module or a new tool-call endpoint fails
 * these tests until it is registered below with a deliberate decision.
 */

const REPO_ROOT = join(__dirname, "..");
const SRC = join(REPO_ROOT, "src");

/** The owner's routing table: the modules it imports are the owner's cards. */
const TOOL_CARD_REGISTRY = "src/components/chat/tool-cards.tsx";

/** The dispatcher that must route through the registry above. */
const TOOL_CALL_VIEW = "src/components/chat/tool-call-view.tsx";

/** The share card — allowed to be reachable from the share surface. */
const REDACTED_CARD = "src/components/chat/redacted-tool-call.tsx";

/** Entry points of the public share surface. */
const SHARE_ENTRIES = ["src/components/chat/share-viewer.tsx", "src/app/share/[token]/page.tsx"];

/**
 * Shared modules a card is allowed to use — not cards themselves, so the share
 * card may reach them. `tool-card` renders a model and knows no tool name;
 * `tool-card-model` and `tool-status` are pure vocabulary.
 */
const NON_CARD_MODULES = [
  "src/components/chat/types.ts",
  "src/components/chat/tool-card.tsx",
  "src/components/chat/tool-card-model.ts",
  "src/components/chat/tool-status.ts",
  "src/components/chat/tool-status-badge.tsx",
];

/**
 * Every module that reads the persisted `toolCalls` column. `owner` means the
 * caller can only ever read their own rows; `public` means the rows may belong
 * to someone else, so they must be redacted first. Adding a reader forces an
 * entry here — that is the point of the test.
 */
const TOOL_CALL_READERS: Array<{
  path: string;
  access: "owner" | "public";
  guardedBy: string;
}> = [
  {
    path: "src/app/api/agent-jobs/runs/[id]/messages/route.ts",
    access: "owner",
    guardedBy: "requireSession() + the run is looked up by userId",
  },
  {
    path: "src/app/api/chat/sessions/share/[token]/messages/route.ts",
    access: "public",
    guardedBy: "serializeSharedChatMessage()",
  },
  {
    path: "src/app/api/chat/sessions/share/[token]/copy/route.ts",
    access: "public",
    guardedBy: "redactStoredToolCalls()",
  },
];

/** Modules that make a payload safe for an anonymous reader. */
const SAFE_SERIALIZERS = ["@/lib/chat/serialize-message", "@/lib/chat/redact-tool-calls"];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry)) files.push(full);
  }
  return files;
}

function toRepoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

function read(repoPath: string): string {
  return readFileSync(join(REPO_ROOT, repoPath), "utf-8");
}

/** Import specifiers of a source file, in source order. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1] ?? "");
}

/**
 * The card modules the owner's router pulls in — the cards themselves and the
 * descriptors behind them. Resolved to repo paths and discovered rather than
 * listed, so a descriptor added to the registry is covered without an edit
 * here.
 */
function ownerCardModules(): string[] {
  return importsOf(read(TOOL_CARD_REGISTRY))
    .filter((spec) => spec.startsWith("."))
    .map((spec) => resolveSpec(spec, TOOL_CARD_REGISTRY))
    .filter((path): path is string => path !== null && !NON_CARD_MODULES.includes(path));
}

/** Resolve a relative or `@/` specifier to a repo path, or null. */
function resolveSpec(spec: string, fromRepoPath: string): string | null {
  const base = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(join(REPO_ROOT, fromRepoPath)), spec)
      : null;
  if (!base) return null;

  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return toRepoPath(candidate);
  }
  return null;
}

/** Every module reachable from the share entries through `src/` imports. */
function reachableFromShare(): Set<string> {
  const seen = new Set<string>();
  const queue = [...SHARE_ENTRIES];

  while (queue.length > 0 && seen.size < 1000) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);

    for (const spec of importsOf(read(current))) {
      const target = resolveSpec(spec, current);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

describe("the share surface cannot reach an owner's tool card", () => {
  const cards = ownerCardModules();

  it("discovers the owner's card modules", () => {
    // Guards the discovery itself: an empty list would make the rest vacuous.
    expect(cards.length).toBeGreaterThan(3);
    expect(cards).toContain("src/components/chat/file-card.tsx");
    expect(cards).toContain("src/components/chat/tool-descriptors/infra.ts");
    expect(cards).not.toContain(REDACTED_CARD);
  });

  it("routes every tool card through the registry", () => {
    // The discovery above reads the registry, so a dispatcher that stopped
    // using it would silently stop being covered.
    expect(importsOf(read(TOOL_CALL_VIEW))).toContain("./tool-cards");
  });

  it("imports no card module from any file on the share surface", () => {
    const surface = walk(SRC)
      .map(toRepoPath)
      .filter((path) => path.toLowerCase().includes("share"));

    expect(surface.length).toBeGreaterThan(1);

    const offenders = new Set<string>();
    for (const path of surface) {
      for (const spec of importsOf(read(path))) {
        const target = resolveSpec(spec, path);
        if (target && cards.includes(target)) offenders.add(`${path} → ${target}`);
      }
    }

    expect(
      [...offenders],
      `These share-surface files import an owner tool card. Share pages must go\n` +
        `through RedactedToolCall instead:\n` +
        [...offenders].map((offender) => `  - ${offender}`).join("\n"),
    ).toEqual([]);
  });

  it("reaches the redacted card and nothing that fetches owner data", () => {
    const reachable = reachableFromShare();

    expect(reachable.has(REDACTED_CARD)).toBe(true);

    const leaked = cards.filter((path) => reachable.has(path));
    expect(
      leaked,
      `The share viewer transitively imports an owner tool card:\n` +
        leaked.map((path) => `  - ${path}`).join("\n"),
    ).toEqual([]);

    // `file-card` downloads through an authenticated endpoint; reaching it from
    // a share page is exactly the regression this guards.
    expect(reachable.has("src/components/chat/file-card.tsx")).toBe(false);
  });

  it("keeps the share card free of args and results", () => {
    const source = read(REDACTED_CARD);

    expect(source).not.toMatch(/\.args\b/);
    expect(source).not.toMatch(/\.result\b/);
    expect(source).not.toMatch(/\.error\b/);
  });
});

describe("every tool-call reader is accounted for", () => {
  const discovered = walk(join(SRC, "app", "api"))
    .map(toRepoPath)
    .filter((path) => /\btoolCalls\b/.test(read(path)))
    .sort();

  const registered = TOOL_CALL_READERS.map((reader) => reader.path).sort();

  it("finds the endpoints that read the toolCalls column", () => {
    expect(discovered.length).toBeGreaterThan(0);
  });

  it("registers a decision for each of them", () => {
    const unregistered = discovered.filter((path) => !registered.includes(path));

    expect(
      unregistered,
      `These endpoints read the persisted toolCalls column but are missing from\n` +
        `TOOL_CALL_READERS in this file. A public reader must serialize through\n` +
        `@/lib/chat/serialize-message or redact through @/lib/chat/redact-tool-calls:\n` +
        unregistered.map((path) => `  - ${path}`).join("\n"),
    ).toEqual([]);
  });

  it("has no stale entries", () => {
    const stale = registered.filter((path) => !discovered.includes(path));

    expect(stale, `TOOL_CALL_READERS references files that no longer read toolCalls`).toEqual([]);
  });

  it("redacts every reader that touches another user's rows", () => {
    for (const reader of TOOL_CALL_READERS) {
      if (reader.access !== "public") continue;

      const imports = importsOf(read(reader.path));
      expect(
        imports.some((spec) => SAFE_SERIALIZERS.includes(spec)),
        `${reader.path} reads rows owned by another user (${reader.guardedBy}) but does not import a share serializer`,
      ).toBe(true);
    }
  });
});
