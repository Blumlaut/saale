import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(),
  sanitizeError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    emailAccount: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/email/sync", () => ({
  syncEmailAccount: vi.fn(),
}));

import * as auth from "@/lib/auth";
import { prisma } from "@/lib/db";
import * as emailSync from "@/lib/email/sync";
import { POST } from "@/app/api/email/sync/route";

describe("POST /api/email/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ── Auth ── */

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await POST();

    expect(response.status).toBe(401);
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
  });

  /* ── Happy path ── */

  it("syncs every enabled account and reports per-account results", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "test@example.com" },
    });
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue([
      { id: "acc-1" },
      { id: "acc-2" },
    ] as never);
    vi.mocked(emailSync.syncEmailAccount)
      .mockResolvedValueOnce({ newMessages: 3, updatedMessages: 1, errors: [] })
      .mockResolvedValueOnce({ newMessages: 0, updatedMessages: 2, errors: ["folder skip"] });

    const response = await POST();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.synced).toBe(true);
    expect(body.results).toEqual([
      { accountId: "acc-1", synced: true, newMessages: 3, updatedMessages: 1, errors: [] },
      {
        accountId: "acc-2",
        synced: true,
        newMessages: 0,
        updatedMessages: 2,
        errors: ["folder skip"],
      },
    ]);
    expect(emailSync.syncEmailAccount).toHaveBeenCalledTimes(2);
    expect(emailSync.syncEmailAccount).toHaveBeenCalledWith("acc-1");
    expect(emailSync.syncEmailAccount).toHaveBeenCalledWith("acc-2");
  });

  /* ── User isolation & scope ── */

  it("only queries the authenticated user's enabled accounts", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-specific-123" },
    });
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue([] as never);

    await POST();

    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith({
      where: { userId: "user-specific-123", enabled: true },
      select: { id: true },
    });
  });

  /* ── Edge cases ── */

  it("returns 200 with empty results when the user has no enabled accounts", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue([] as never);

    const response = await POST();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.synced).toBe(true);
    expect(body.results).toEqual([]);
    expect(emailSync.syncEmailAccount).not.toHaveBeenCalled();
  });

  it("still succeeds when only some accounts fail, logging each failure", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue([
      { id: "acc-ok" },
      { id: "acc-bad" },
    ] as never);
    vi.mocked(emailSync.syncEmailAccount)
      .mockResolvedValueOnce({ newMessages: 1, updatedMessages: 0, errors: [] })
      .mockRejectedValueOnce(new Error("IMAP connection refused"));

    const response = await POST();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.synced).toBe(true);
    expect(body.results).toEqual([
      { accountId: "acc-ok", synced: true, newMessages: 1, updatedMessages: 0, errors: [] },
      { accountId: "acc-bad", synced: false, error: "IMAP connection refused" },
    ]);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to sync email account acc-bad:",
      expect.any(Error),
    );
  });

  it("returns 500 with the aggregated error when every account fails", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue([
      { id: "acc-1" },
      { id: "acc-2" },
    ] as never);
    vi.mocked(emailSync.syncEmailAccount).mockRejectedValue(new Error("boom"));

    const response = await POST();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.synced).toBe(false);
    expect(body.error).toBe("boom; boom");
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { synced: boolean }) => !r.synced)).toBe(true);
  });
});
