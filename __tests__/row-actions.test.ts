import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Row control visibility constraint.
 *
 * A row shows its controls: one of its own, and a ⋯ menu for the rest (see the
 * design skill's `lists.md`). `ROW_ACTION` is for the other kind of affordance —
 * an inline hint the row works without — so it hides something until the row is
 * hovered, and a row action wearing it is an action nobody finds. This test
 * fails when `ROW_ACTION` spreads beyond the hints listed in `QUIET_HINTS`, and
 * when a hover reveal has no `group` to reveal from.
 */

const REPO_ROOT = join(__dirname, "..");
const SRC = join(REPO_ROOT, "src");

/** shadcn primitives style a `group/<name>` their consumer declares. */
const PRIMITIVE_DIR = "src/components/ui/";

const ROW_ACTION = "ROW_ACTION";

/**
 * The files where something may wait for a hover, with the reason it may.
 *
 * Both render a hint the row is usable without: the kebab next to it, or the
 * row itself, does the work. A row action belongs in a visible menu instead.
 */
const QUIET_HINTS: Record<string, string> = {
  "src/components/chat/tool-card.tsx": "the open-link arrow on a transcript row",
  "src/components/files/file-browser.tsx": "the selection checkbox beside the row menu",
};

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

/** The group a class token declares: `null` for `group`, `"row"` for `group/row`. */
function declaredGroup(token: string): string | null | undefined {
  if (token === "group") return null;
  if (/^group\/[\w-]+$/.test(token)) return token.slice("group/".length);
  return undefined;
}

/** Module-level string constants, so a shared class reads like the class it holds. */
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

export interface HoverClasses {
  /** Something in this file only shows on hover. */
  reveals: boolean;
  /** The file declares a group, so the reveal has something to hang off. */
  declares: boolean;
  /** The file reaches for the shared quiet class. */
  usesRowAction: boolean;
  /** Lines that reveal on hover, for the failure message. */
  revealLines: number[];
}

/** What a file does with hover: reveal on a group, declare one, or both. */
export function hoverClasses(repoPath: string, source: string): HoverClasses {
  const file = ts.createSourceFile(
    repoPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const constants = localConstants(file);
  const result: HoverClasses = {
    reveals: false,
    declares: false,
    usesRowAction: false,
    revealLines: [],
  };

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
      if (reveals) result.usesRowAction = true;
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

function components(): string[] {
  return walk(SRC)
    .map(toRepoPath)
    .filter((path) => !path.startsWith(PRIMITIVE_DIR))
    .sort();
}

describe("row controls stay visible", () => {
  it("keeps the hover-quiet class for inline hints only", () => {
    const offenders = components()
      .map((path) => ({ path, classes: hoverClasses(path, read(path)) }))
      .filter(({ path, classes }) => classes.usesRowAction && !(path in QUIET_HINTS));

    expect(
      offenders.map(
        ({ path, classes }) =>
          `${path} (lines ${classes.revealLines.join(", ")}) hides a control behind a hover:
           show it, and put the rest in the row's menu`,
      ),
    ).toEqual([]);
  });

  it("reveals a quiet hint from a group in the same file", () => {
    const offenders = components()
      .map((path) => ({ path, classes: hoverClasses(path, read(path)) }))
      .filter(({ classes }) => classes.reveals && !classes.declares);

    expect(
      offenders.map(
        ({ path, classes }) =>
          `${path} (lines ${classes.revealLines.join(", ")}) reveals on hover with no group class`,
      ),
    ).toEqual([]);
  });
});
