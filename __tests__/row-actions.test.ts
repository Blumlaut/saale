import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Hover-revealed row actions constraint.
 *
 * A row action stays invisible until its row is hovered: `ROW_ACTION` is
 * `opacity-0 … group-hover:opacity-100`, and any other `group-*` variant needs
 * the same. The `group` class has to live on the row, so a component that
 * reveals something on hover but declares no group — here or in the row that
 * renders it — hides its buttons from every mouse user.
 *
 * This test walks the components and fails when a file reveals on hover without
 * a `group` to reveal from, either in its own file or through the host row
 * registered in `ROW_ACTION_HOSTS`.
 */

const REPO_ROOT = join(__dirname, "..");
const SRC = join(REPO_ROOT, "src");

/** shadcn primitives style a `group/<name>` their consumer declares. */
const PRIMITIVE_DIR = "src/components/ui/";

/** The class that reveals a row's actions on hover. */
const ROW_ACTION = "ROW_ACTION";

/**
 * Action components whose `group` lives in the row that renders them.
 *
 * A shared actions component carries `ROW_ACTION` but no row of its own, so it
 * registers the row that does. The host must declare the group and put the
 * `{actions}` slot inside it.
 */
const ROW_ACTION_HOSTS: { actions: string; host: string; slot: string }[] = [
  {
    actions: "src/components/mcp/mcp-server-row-actions.tsx",
    host: "src/components/mcp/mcp-server-row.tsx",
    slot: "actions",
  },
  {
    actions: "src/components/prompts/prompt-row-actions.tsx",
    host: "src/components/prompts/prompt-row.tsx",
    slot: "actions",
  },
];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (entry.endsWith(".tsx")) files.push(full);
  }
  return files;
}

function toRepoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

function read(repoPath: string): string {
  return readFileSync(join(REPO_ROOT, repoPath), "utf-8");
}

function parse(repoPath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(repoPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Module-level string constants, so a shared row class reads like the class it holds. */
function localConstants(source: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      constants.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constants;
}

/** Every class token in a node's string literals, plus the identifiers it names. */
function collect(node: ts.Node, tokens: Set<string>, refs: Set<string>): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    for (const token of node.text.split(/\s+/)) if (token) tokens.add(token);
  } else if (ts.isIdentifier(node)) {
    refs.add(node.text);
  }
  ts.forEachChild(node, (child) => collect(child, tokens, refs));
}

/** The group a class token declares: `null` for `group`, `"row"` for `group/row`. */
export function declaredGroup(token: string): string | null | undefined {
  if (token === "group") return null;
  if (/^group\/[\w-]+$/.test(token)) return token.slice("group/".length);
  return undefined;
}

interface HoverClasses {
  /** Something in this file only shows on hover. */
  reveals: boolean;
  /** The file declares a group, so the reveal has something to hang off. */
  declares: boolean;
  /** Lines that reveal on hover, for the failure message. */
  revealLines: number[];
}

/** What a file does with hover: reveal on a group, declare one, or both. */
export function hoverClasses(repoPath: string, source: string): HoverClasses {
  const file = parse(repoPath, source);
  const constants = localConstants(file);
  const result: HoverClasses = { reveals: false, declares: false, revealLines: [] };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // A row's class list may be built in a variable, e.g. `const className = cn(…)`.
      for (const token of node.text.split(/\s+/)) {
        if (declaredGroup(token) !== undefined) result.declares = true;
      }
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tokens = new Set<string>();
      const refs = new Set<string>();
      for (const attribute of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        if (attribute.name.getText() !== "className" || !attribute.initializer) continue;
        collect(attribute.initializer, tokens, refs);
      }
      for (const ref of refs) {
        const value = constants.get(ref);
        if (value !== undefined) collect(ts.factory.createStringLiteral(value), tokens, refs);
      }

      let reveals = refs.has(ROW_ACTION);
      for (const token of tokens) {
        if (token.startsWith("group-")) reveals = true;
        if (declaredGroup(token) !== undefined) result.declares = true;
      }
      if (reveals) {
        result.reveals = true;
        const { line } = file.getLineAndCharacterOfPosition(opening.getStart(file));
        result.revealLines.push(line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return result;
}

/**
 * Where a row renders its `{actions}` slot, and whether the slot inherits a
 * `group` from the row that renders it.
 */
export function slotViolations(
  repoPath: string,
  source: string,
  slot: string,
): { line: number; covered: boolean }[] {
  const file = parse(repoPath, source);
  const constants = localConstants(file);
  const found: { line: number; covered: boolean }[] = [];

  const visit = (node: ts.Node, groups: (string | null)[]): void => {
    if (ts.isJsxExpression(node) && node.expression) {
      const tokens = new Set<string>();
      const refs = new Set<string>();
      collect(node.expression, tokens, refs);
      if (refs.has(slot)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        found.push({ line: line + 1, covered: groups.length > 0 });
      }
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tokens = new Set<string>();
      const refs = new Set<string>();
      for (const attribute of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        if (attribute.name.getText() !== "className" || !attribute.initializer) continue;
        collect(attribute.initializer, tokens, refs);
      }
      for (const ref of refs) {
        const value = constants.get(ref);
        if (value !== undefined) collect(ts.factory.createStringLiteral(value), tokens, refs);
      }
      const declared = [...tokens]
        .map(declaredGroup)
        .filter((group): group is string | null => group !== undefined);
      for (const child of node.getChildren(file)) visit(child, [...groups, ...declared]);
      return;
    }
    for (const child of node.getChildren(file)) visit(child, groups);
  };

  visit(file, []);
  return found;
}

function components(): string[] {
  return walk(SRC)
    .map(toRepoPath)
    .filter((path) => !path.startsWith(PRIMITIVE_DIR))
    .sort();
}

describe("hover-revealed row actions", () => {
  it("declares the group its actions reveal from, here or in the host row", () => {
    const registered = new Set(ROW_ACTION_HOSTS.map((entry) => entry.actions));
    const offenders = components()
      .filter((path) => !registered.has(path))
      .map((path) => ({ path, classes: hoverClasses(path, read(path)) }))
      .filter(({ classes }) => classes.reveals && !classes.declares);

    expect(
      offenders.map(
        ({ path, classes }) =>
          `${path} (lines ${classes.revealLines.join(", ")}) reveals on hover with no group class`,
      ),
    ).toEqual([]);
  });

  it("registers a host row that declares the group for a shared actions component", () => {
    for (const entry of ROW_ACTION_HOSTS) {
      const host = hoverClasses(entry.host, read(entry.host));
      expect(host.declares, `${entry.host} declares no group`).toBe(true);

      const slots = slotViolations(entry.host, read(entry.host), entry.slot);
      // A stale entry would hide a real violation, so the host has to take the slot.
      expect(slots.length, `${entry.host} renders no {${entry.slot}}`).toBeGreaterThan(0);
      expect(
        slots
          .filter((slot) => !slot.covered)
          .map((slot) => `${entry.host}:${slot.line} renders {${entry.slot}} outside a group`),
      ).toEqual([]);
    }
  });
});
