// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SidebarNavProvider } from "@/components/providers/sidebar-nav-provider";
import { MobileNav } from "@/components/layout/mobile-nav";
import { resetSessionPermissionsCache } from "@/hooks/use-session-permissions";
import { BUILTIN_ROLES, mergeRolePermissions } from "@/lib/permissions/roles";

const { pathnameRef } = vi.hoisted(() => ({
  pathnameRef: { current: "/dashboard/chat" },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
}));

/** Answer the layout GET and the permissions check depending on the URL. */
function mockSession(role: string | null) {
  const fixtures = mockPermissions();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/permissions")) {
        return role
          ? new Response(JSON.stringify({ role, permissions: fixtures[role] }), { status: 200 })
          : new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
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

/** What /api/permissions would answer for a built-in role. */
function mockPermissions(): Record<string, ReturnType<typeof mergeRolePermissions>> {
  return Object.fromEntries(
    BUILTIN_ROLES.map((role) => [role.name, mergeRolePermissions(BUILTIN_ROLES, role.name)]),
  );
}

beforeEach(() => {
  pathnameRef.current = "/dashboard/chat";
  resetSessionPermissionsCache();
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

    await waitFor(() => expect(labels()).toHaveLength(7));
    expect(labels()).not.toContain("Admin");
  });

  it("mirrors the admin sidebar inside the admin panel, with a way back to the app", async () => {
    pathnameRef.current = "/admin/users";
    mockSession("admin");
    renderNav();

    await waitFor(() =>
      expect(labels()).toEqual(["Models", "Users", "Roles", "Settings", "Dashboard"]),
    );

    // The current admin page is flagged, and Dashboard links back to the app.
    const active = screen.getByRole("link", { name: /Users/ });
    expect(active).toHaveClass("text-foreground");
    expect(active).toHaveAttribute("href", "/admin/users");
    expect(screen.getByRole("link", { name: /Dashboard/ })).toHaveAttribute(
      "href",
      "/dashboard/chat",
    );
  });

  it("falls back to the dashboard bar when the permissions check fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/permissions")) return new Response("{}", { status: 500 });
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderNav();

    await waitFor(() => expect(labels()).toHaveLength(7));
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to load session permissions:",
      expect.anything(),
    );
    consoleError.mockRestore();
  });
});
