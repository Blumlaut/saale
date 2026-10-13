import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { MODAL_SCENARIOS } from "../e2e/modal-scenarios";

/**
 * Overlay coverage constraint.
 *
 * `e2e/modal-overflow.spec.ts` can only check the overlays it knows about, so a
 * newly added modal would slip through silently. This test closes that hole:
 * every file that renders an overlay popup must be registered in
 * `e2e/modal-scenarios.ts` — with an automated scenario, or with an explicit
 * `skip` reason. Adding a modal therefore forces a decision about its layout.
 */

const REPO_ROOT = join(__dirname, "..");

/** Overlay popups rendered by our own components (not Select/Popover/Menu popups). */
const OVERLAY_RENDER = /<(DialogContent|AlertDialogContent|SheetContent)\b/;

/** Shared primitives that *define* the overlays — nothing to cover. */
const PRIMITIVE_DIR = "src/components/ui/";

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (entry.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

function toRepoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

function overlayComponents(): string[] {
  return walk(join(REPO_ROOT, "src"))
    .map(toRepoPath)
    .filter((path) => !path.startsWith(PRIMITIVE_DIR))
    .filter((path) => OVERLAY_RENDER.test(readFileSync(join(REPO_ROOT, path), "utf-8")))
    .sort();
}

/**
 * The page file a scenario's URL renders.
 *
 * A concrete id in a scenario URL still points at a dynamic route
 * (`/dashboard/council/e2e-council/files` → `[councilId]/files/page.tsx`), so a
 * segment that does not exist literally is matched against the app tree's
 * `[param]` directories. Scenarios can therefore use the URLs a spec really
 * visits rather than a synthetic `[councilId]`.
 */
function routeFile(route: string): string {
  const segments = route.replace(/^\//, "").split("/").filter(Boolean);
  let dir = join(REPO_ROOT, "src", "app");

  for (const segment of segments) {
    const exact = join(dir, segment);
    if (existsSync(exact)) {
      dir = exact;
      continue;
    }

    const dynamic = existsSync(dir)
      ? readdirSync(dir).find((name) => /^\[.+\]$/.test(name) && existsSync(join(dir, name)))
      : undefined;
    if (!dynamic) return join(dir, segment, "page.tsx");
    dir = join(dir, dynamic);
  }

  return join(dir, "page.tsx");
}

/** Class strings in a component that use `grid` without declaring a base track. */
function bareGridClasses(source: string): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(/"([^"]*)"/g)) {
    const classes = match[1] ?? "";
    const tokens = classes.split(/\s+/);
    if (!tokens.includes("grid")) continue;
    if (tokens.some((token) => token.startsWith("grid-cols-"))) continue;
    offenders.push(classes.trim());
  }
  return offenders;
}

describe("overlay coverage", () => {
  const components = overlayComponents();
  const registered = new Set(MODAL_SCENARIOS.flatMap((scenario) => scenario.sources));

  it("finds overlay components to check", () => {
    expect(components.length).toBeGreaterThan(10);
  });

  it("registers a scenario or skip reason for every overlay component", () => {
    const uncovered = components.filter((path) => !registered.has(path));
    expect(
      uncovered,
      `These components render a modal but are missing from e2e/modal-scenarios.ts.\n` +
        `Add a scenario (path + open) or an entry with a documented skip reason:\n` +
        uncovered.map((path) => `  - ${path}`).join("\n"),
    ).toEqual([]);
  });

  it("keeps the registry in sync with the components that render overlays", () => {
    const sourcePaths = [...registered].sort();
    const stale = sourcePaths.filter((path) => !components.includes(path));
    expect(
      stale,
      `e2e/modal-scenarios.ts references components that no longer render a modal:\n` +
        stale.map((path) => `  - ${path}`).join("\n"),
    ).toEqual([]);
  });

  it("gives every scenario either an opener or a skip reason", () => {
    for (const scenario of MODAL_SCENARIOS) {
      const hasOpener = typeof scenario.open === "function";
      const hasSkip = typeof scenario.skip === "string" && scenario.skip.length > 0;
      expect(
        hasOpener !== hasSkip,
        `${scenario.name}: needs exactly one of \`open\` or \`skip\``,
      ).toBe(true);
    }
  });

  it("points every scenario at a real route", () => {
    for (const scenario of MODAL_SCENARIOS) {
      expect(
        existsSync(routeFile(scenario.path)),
        `${scenario.name}: ${scenario.path} does not resolve to a page`,
      ).toBe(true);
    }
  });

  it("declares a base grid track on every grid inside an overlay", () => {
    // A bare `grid` (implicit `auto` track) is sized by its items' min-content, so
    // a long unbreakable string or a nowrap row can push the modal's content past
    // its bounds — `grid-cols-1` (`minmax(0, 1fr)`) keeps the track inside.
    const offenders = components.flatMap((path) =>
      bareGridClasses(readFileSync(join(REPO_ROOT, path), "utf-8")).map(
        (classes) => `${path}: "${classes}"`,
      ),
    );
    expect(
      offenders,
      `Overlay grids must declare a base column track (add \`grid-cols-1\` or similar):\n` +
        offenders.map((entry) => `  - ${entry}`).join("\n"),
    ).toEqual([]);
  });
});
