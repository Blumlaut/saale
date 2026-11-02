import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockRequireSession, mockMarkPushSeen } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockMarkPushSeen: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));
vi.mock("@/lib/push/seen", () => ({
  markPushSeen: (...args: unknown[]) => mockMarkPushSeen(...args),
}));

import { POST } from "@/app/api/push/seen/route";

const USER_ID = "user-1";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/push/seen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("push seen route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
    mockMarkPushSeen.mockResolvedValue(undefined);
  });

  it("records the page this browser has on screen", async () => {
    const response = await POST(request({ url: "/dashboard/chat/chat-1" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockMarkPushSeen).toHaveBeenCalledWith(USER_ID, "/dashboard/chat/chat-1");
  });

  it("refuses a body without a path", async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(400);
    expect(mockMarkPushSeen).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await POST(request({ url: "/dashboard/chat/chat-1" }));

    expect(response.status).toBe(401);
    expect(mockMarkPushSeen).not.toHaveBeenCalled();
  });
});
