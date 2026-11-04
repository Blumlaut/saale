import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(),
  requireCalendarAccountOwner: vi.fn(),
  sanitizeError: (err: unknown) => (err instanceof Error ? err.message : "error"),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    calendarAccount: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    calendar: { upsert: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn().mockReturnValue("encrypted-password"),
}));

vi.mock("@/lib/calendar/caldav", () => ({
  connectCalDAV: vi.fn(),
}));

import * as auth from "@/lib/auth";
import { prisma } from "@/lib/db";
import { connectCalDAV } from "@/lib/calendar/caldav";
import { POST } from "@/app/api/calendar/accounts/[accountId]/test-connection/route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/calendar/accounts/x/test-connection", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never as import("next/server").NextRequest;
}

const params = (accountId: string) => ({ params: Promise.resolve({ accountId }) });

function mockSignedIn() {
  vi.mocked(auth.requireSession).mockResolvedValue({
    ok: true,
    user: { id: "user-1", email: "owner@example.com" },
  } as never);
}

describe("POST /api/calendar/accounts/:accountId/test-connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("refuses another user's account before touching its credentials", async () => {
    mockSignedIn();
    vi.mocked(auth.requireCalendarAccountOwner).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    } as never);

    const response = await POST(request({}), params("acc-victim"));

    expect(response.status).toBe(404);
    expect(connectCalDAV).not.toHaveBeenCalled();
    expect(prisma.calendarAccount.update).not.toHaveBeenCalled();
  });

  it("tests a new account from the body and keeps it on success", async () => {
    mockSignedIn();
    vi.mocked(prisma.calendarAccount.create).mockResolvedValue({ id: "acc-new" } as never);
    vi.mocked(connectCalDAV).mockResolvedValue({
      client: {
        fetchCalendars: vi.fn().mockResolvedValue([{ url: "https://cal/1", displayName: "Work" }]),
      },
      account: {},
    } as never);

    const response = await POST(
      request({ serverUrl: "https://cal.example.com", username: "ada", password: "secret" }),
      params("new"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(auth.requireCalendarAccountOwner).not.toHaveBeenCalled();
    expect(prisma.calendarAccount.update).toHaveBeenCalledWith({
      where: { id: "acc-new" },
      data: { name: "CalDAV (ada)", enabled: true },
    });
  });

  it("drops the temporary account when the connection is refused", async () => {
    mockSignedIn();
    vi.mocked(prisma.calendarAccount.create).mockResolvedValue({ id: "acc-new" } as never);
    vi.mocked(connectCalDAV).mockRejectedValue(new Error("401 Unauthorized"));
    vi.mocked(prisma.calendarAccount.delete).mockResolvedValue({} as never);

    const response = await POST(
      request({ serverUrl: "https://cal.example.com", username: "ada", password: "wrong" }),
      params("new"),
    );

    expect(response.status).toBe(502);
    expect(prisma.calendarAccount.delete).toHaveBeenCalledWith({ where: { id: "acc-new" } });
    expect(prisma.calendarAccount.update).not.toHaveBeenCalled();
  });
});
