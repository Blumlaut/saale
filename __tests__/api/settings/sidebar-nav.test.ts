import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

const mockRequireSession = vi.fn();
const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

// The route writes through the settings registry, which evicts pooled sessions
// for session-affecting settings. Sidebar layout is not one of them, but the
// module is imported either way — keep it out of the graph.
vi.mock("@/lib/pi/agent-pool", () => ({
  evictUserSessions: vi.fn().mockResolvedValue(0),
}));

// The route drops nav items this user may not open (the council entry, which is
// admin-only). Default: allowed, with `mockCanUseCouncil` flipped per case.
const mockCanUseCouncil = vi.fn(async (..._args: unknown[]) => true);
vi.mock("@/lib/council/access", () => ({
  canUseCouncil: (...args: unknown[]) => mockCanUseCouncil(...args),
}));

import { GET, PATCH } from "@/app/api/settings/sidebar-nav/route";
import { SIDEBAR_NAV_ITEM_IDS } from "@/lib/navigation/sidebar-nav";

const USER_ID = "user-1";

function auth() {
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
}

function patch(body: unknown) {
  return new NextRequest("http://localhost/api/settings/sidebar-nav", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface UpdateArgs {
  where: { userId: string };
  data: Record<string, unknown>;
}

/** The arguments of the last `prisma.appSettings.update` call. */
function lastUpdate(): UpdateArgs {
  const args = mockUpdate.mock.calls.at(-1)?.[0] as UpdateArgs | undefined;
  if (!args) throw new Error("prisma.appSettings.update was not called");
  return args;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCanUseCouncil.mockResolvedValue(true);
  auth();
  mockUpsert.mockResolvedValue({ id: "settings-1", userId: USER_ID, sidebarItems: null });
  mockUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "settings-1",
    userId: USER_ID,
    sidebarItems: null,
    ...data,
  }));
});

describe("GET /api/settings/sidebar-nav", () => {
  it("requires a session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("returns the default layout when the user has no settings row", async () => {
    mockFindUnique.mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([...SIDEBAR_NAV_ITEM_IDS]);
    // Visible by default is per item: the opt-in entries start hidden.
    expect(body.items.find((item: { id: string }) => item.id === "chat").hidden).toBe(false);
    expect(body.items.find((item: { id: string }) => item.id === "council").hidden).toBe(true);
  });

  it("drops a nav item this user may not open", async () => {
    mockCanUseCouncil.mockResolvedValue(false);
    mockFindUnique.mockResolvedValue({
      sidebarItems: [
        { id: "chat", hidden: false },
        { id: "council", hidden: false },
      ],
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    // Not hidden — absent: offering a toggle for a page that cannot be opened is
    // what a filtered list avoids.
    expect(body.items.map((item: { id: string }) => item.id)).not.toContain("council");
    expect(body.items.map((item: { id: string }) => item.id)).toContain("chat");
  });

  it("scopes the lookup to the authenticated user", async () => {
    mockFindUnique.mockResolvedValue({ sidebarItems: [{ id: "chat", hidden: false }] });

    await GET();

    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });

  it("resolves a stored layout against the registry", async () => {
    mockFindUnique.mockResolvedValue({
      sidebarItems: [
        { id: "settings", hidden: false },
        { id: "retired-page", hidden: false },
        { id: "mail", hidden: true },
      ],
    });

    const res = await GET();
    const { items } = await res.json();

    expect(items[0]).toEqual({ id: "settings", hidden: false });
    expect(items.map((item: { id: string }) => item.id)).not.toContain("retired-page");
    expect(items.find((item: { id: string }) => item.id === "mail").hidden).toBe(true);
  });
});

describe("PATCH /api/settings/sidebar-nav", () => {
  it("persists a reordered, partly hidden layout", async () => {
    const items = [
      { id: "tasks", hidden: false },
      { id: "chat", hidden: false },
      { id: "settings", hidden: false },
    ];

    const res = await PATCH(patch({ items }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(lastUpdate().where).toEqual({ userId: USER_ID });

    const written = lastUpdate().data.sidebarItems as { id: string }[];
    expect(written.slice(0, 2).map((entry) => entry.id)).toEqual(["tasks", "chat"]);
    // Registry items the layout doesn't mention come back at their own default.
    expect(body.items.map((item: { id: string }) => item.id)).toHaveLength(
      SIDEBAR_NAV_ITEM_IDS.length,
    );
    expect(body.items.at(-1)).toEqual({ id: "infra", hidden: false });
  });

  it("clears the column when items is null", async () => {
    const res = await PATCH(patch({ items: null }));

    expect(res.status).toBe(200);
    expect(lastUpdate().data.sidebarItems).toBe(Prisma.DbNull);
    expect((await res.json()).items).toHaveLength(SIDEBAR_NAV_ITEM_IDS.length);
  });

  it("rejects an unknown item id", async () => {
    const res = await PATCH(patch({ items: [{ id: "secrets", hidden: false }] }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid sidebar layout");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects duplicate items", async () => {
    const res = await PATCH(
      patch({
        items: [
          { id: "chat", hidden: false },
          { id: "chat", hidden: true },
        ],
      }),
    );

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("keeps pinned items visible when the layout hides every item", async () => {
    const items = ["chat", "mail", "calendar", "tasks", "jobs", "infra", "settings"].map((id) => ({
      id,
      hidden: true,
    }));

    const res = await PATCH(patch({ items }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items.find((item: { id: string }) => item.id === "settings").hidden).toBe(false);

    // The stored layout is coerced too — only the pinned item survives.
    const written = lastUpdate().data.sidebarItems as { id: string; hidden: boolean }[];
    expect(written.filter((entry) => !entry.hidden).map((entry) => entry.id)).toEqual(["settings"]);
  });

  it("rejects hidden flags that are not booleans", async () => {
    const res = await PATCH(patch({ items: [{ id: "chat", hidden: "yes" }] }));

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects bodies that aren't a layout", async () => {
    for (const body of [{}, { items: "chat" }, { items: [1, 2, 3] }, "not json"]) {
      mockUpdate.mockClear();
      const res = await PATCH(patch(body));

      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(mockUpdate).not.toHaveBeenCalled();
    }
  });

  it("rejects a layout longer than the item registry", async () => {
    const items = Array.from({ length: 8 }, () => ({ id: "chat", hidden: false }));

    const res = await PATCH(patch({ items }));

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
