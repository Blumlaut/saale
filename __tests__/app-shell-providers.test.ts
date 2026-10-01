import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Provider wiring constraint.
 *
 * `MobileNav` and `DashboardNav` read `SidebarNavContext` and throw without a
 * provider, so rendering them anywhere but the shell (`AppShell`) takes a whole
 * route down. That is exactly how every `/admin/*` page shipped broken
 * ("useSidebarNav must be used within a SidebarNavProvider"), with lint,
 * typecheck and the unit suite all green — none of them look at React context
 * wiring. This test does, statically, so the wiring cannot regress silently.
 */

const REPO_ROOT = join(__dirname, "..");
const SHELL = "src/components/layout/app-shell.tsx";

/** Components that require `SidebarNavProvider` — only the shell may render them. */
const PROVIDER_BOUND_NAVS = ["<MobileNav", "<DashboardNav"];

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

describe("app shell providers", () => {
  it("renders the provider-bound navs only inside the shell", () => {
    const offenders = walk(join(REPO_ROOT, "src"))
      .map(toRepoPath)
      .filter((path) => path !== SHELL)
      .filter((path) => {
        const source = readFileSync(join(REPO_ROOT, path), "utf-8");
        const rendersNav = PROVIDER_BOUND_NAVS.some((nav) => source.includes(nav));
        // Handing the nav to the shell as a prop is fine — it renders inside.
        return rendersNav && !source.includes("<AppShell");
      });

    expect(
      offenders,
      `${offenders.join(", ")} renders a nav that needs SidebarNavProvider — ` +
        `render it through AppShell (${SHELL}) instead`,
    ).toEqual([]);
  });

  it("keeps the bottom bar in the shell", () => {
    const shell = readFileSync(join(REPO_ROOT, SHELL), "utf-8");
    expect(shell).toContain("<MobileNav");
    expect(shell).toContain("<SidebarNavProvider>");
  });
});
