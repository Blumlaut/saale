// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/layout/app-shell";
import { useSidebarNav } from "@/components/providers/sidebar-nav-provider";
import type { SidebarNavEntry } from "@/lib/navigation/sidebar-nav";

/**
 * The shell owns the providers the navs depend on.
 *
 * Regression guard: the admin layout used to render `MobileNav` without a
 * `SidebarNavProvider`, so every admin page threw "useSidebarNav must be used
 * within a SidebarNavProvider". These tests render the real shell and assert
 * that both the bottom bar and the page content can read the stored layout.
 */

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/chat",
  useRouter: () => routerMock,
}));

/** Page content that reads the same layout the bottom bar renders. */
function LayoutProbe() {
  const { visibleItems, loading } = useSidebarNav();
  return (
    <p data-testid="probe">{loading ? "loading" : visibleItems.map((item) => item.id).join(" ")}</p>
  );
}

/** The bottom bar's labels, left to right. */
function mobileNavLabels(): string[] {
  const bar = screen.getByRole("navigation");
  return [...bar.querySelectorAll("a")].map((link) => (link.textContent ?? "").trim());
}

async function probeText(): Promise<string[]> {
  return (await screen.findAllByTestId("probe")).map((el) => el.textContent ?? "");
}

/** Answer the sidebar layout GET with a stored layout. */
function mockStoredLayout(items: SidebarNavEntry[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ items }), { status: 200 })),
  );
}

const STORED: SidebarNavEntry[] = [
  { id: "jobs", hidden: false },
  { id: "chat", hidden: false },
  { id: "tasks", hidden: true },
  { id: "settings", hidden: false },
];

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("AppShell", () => {
  it("gives the bottom bar and the page the user's stored layout", async () => {
    mockStoredLayout(STORED);

    render(
      <AppShell nav={<div data-testid="desktop-nav" />}>
        <LayoutProbe />
      </AppShell>,
    );

    // Hidden items (tasks) stay out; unmentioned items keep their registry order.
    const expected = ["Jobs", "Chat", "Settings", "Mail", "Contacts", "Calendar", "Servers"];
    await waitFor(() => expect(mobileNavLabels()).toEqual(expected));

    // Both shells render the page, and both see the provider's layout.
    const probes = await probeText();
    expect(probes).toEqual([
      "jobs chat settings mail contacts calendar infra",
      "jobs chat settings mail contacts calendar infra",
    ]);

    expect(screen.getByTestId("desktop-nav")).toBeInTheDocument();
  });

  it("falls back to the default layout when loading fails, and logs the failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );

    render(
      <AppShell nav={<div />}>
        <LayoutProbe />
      </AppShell>,
    );

    // A nav is the only way out of a page, so it must never come up empty.
    await waitFor(() => expect(mobileNavLabels()).toHaveLength(8));
    expect(mobileNavLabels()).toEqual([
      "Chat",
      "Mail",
      "Contacts",
      "Calendar",
      "Tasks",
      "Jobs",
      "Servers",
      "Settings",
    ]);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to load sidebar navigation layout:",
      expect.anything(),
    );
    consoleError.mockRestore();
  });
});
