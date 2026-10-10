// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SidebarNavProvider } from "@/components/providers/sidebar-nav-provider";
import { MobileNav } from "@/components/layout/mobile-nav";

const { pathnameRef } = vi.hoisted(() => ({
  pathnameRef: { current: "/dashboard/chat" },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
}));

/** Answer the layout GET and the session check depending on the URL. */
function mockSession(role: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/get-session")) {
        return new Response(JSON.stringify({ user: role ? { role } : {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }),
  );
}

/** The bottom bar's labels, left to right. */
function labels(): string[] {
  const bar = screen.getByRole("navigation");
  return [...bar.querySelectorAll("a")].map((link) => (link.textContent ?? "").trim());
}

function renderNav() {
  render(
    <SidebarNavProvider>
      <MobileNav />
    </SidebarNavProvider>,
  );
}

beforeEach(() => {
  pathnameRef.current = "/dashboard/chat";
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("MobileNav", () => {
  it("appends the Admin item to the bar for admins", async () => {
    mockSession("admin");
    renderNav();

    // The bar shows the layout first; the Admin item lands when the session resolves.
    await waitFor(() =>
      expect(labels()).toEqual([
        "Chat",
        "Mail",
        "Contacts",
        "Calendar",
        "Tasks",
        "Jobs",
        "Servers",
        "Settings",
        "Admin",
      ]),
    );
  });

  it("shows no Admin item for regular users", async () => {
    mockSession("user");
    renderNav();

    await waitFor(() => expect(labels()).toHaveLength(8));
    expect(labels()).not.toContain("Admin");
  });

  it("mirrors the admin sidebar inside the admin panel, with a way back to the app", async () => {
    pathnameRef.current = "/admin/users";
    mockSession("admin");
    renderNav();

    await waitFor(() => expect(labels()).toEqual(["Models", "Users", "Settings", "Dashboard"]));

    // The current admin page is flagged, and Dashboard links back to the app.
    const active = screen.getByRole("link", { name: /Users/ });
    expect(active).toHaveClass("text-foreground");
    expect(active).toHaveAttribute("href", "/admin/users");
    expect(screen.getByRole("link", { name: /Dashboard/ })).toHaveAttribute(
      "href",
      "/dashboard/chat",
    );
  });

  it("falls back to the dashboard bar when the session check fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/auth/get-session")) {
          return new Response("{}", { status: 500 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderNav();

    await waitFor(() => expect(labels()).toHaveLength(8));
    expect(consoleError).toHaveBeenCalledWith("Failed to check admin status:", expect.anything());
    consoleError.mockRestore();
  });
});
