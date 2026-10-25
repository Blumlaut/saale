import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockRequireSession, mockPushSubscription, mockIsPushConfigured } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockPushSubscription: { upsert: vi.fn(), deleteMany: vi.fn() },
  mockIsPushConfigured: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));
vi.mock("@/lib/db", () => ({ prisma: { pushSubscription: mockPushSubscription } }));
vi.mock("@/lib/push/config", () => ({ isPushConfigured: mockIsPushConfigured }));

import { DELETE, POST } from "@/app/api/push/subscribe/route";

const USER_ID = "user-1";
const ENDPOINT = "https://push.example.com/device-1";

function request(method: "POST" | "DELETE", body: unknown, userAgent = "Safari/605") {
  return new NextRequest("http://localhost/api/push/subscribe", {
    method,
    headers: { "Content-Type": "application/json", "user-agent": userAgent },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const subscription = {
  endpoint: ENDPOINT,
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};

describe("push subscription route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
    mockIsPushConfigured.mockReturnValue(true);
    mockPushSubscription.upsert.mockResolvedValue({});
    mockPushSubscription.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("stores the subscription for the signed-in user", async () => {
    const response = await POST(request("POST", subscription));

    expect(response.status).toBe(200);
    expect(mockPushSubscription.upsert).toHaveBeenCalledWith({
      where: { endpoint: ENDPOINT },
      create: {
        endpoint: ENDPOINT,
        userId: USER_ID,
        p256dh: "p256dh-key",
        auth: "auth-key",
        userAgent: "Safari/605",
      },
      update: {
        userId: USER_ID,
        p256dh: "p256dh-key",
        auth: "auth-key",
        userAgent: "Safari/605",
      },
    });
  });

  it("refuses a subscription that is missing its keys", async () => {
    const response = await POST(request("POST", { endpoint: ENDPOINT, keys: { p256dh: "" } }));

    expect(response.status).toBe(400);
    expect(mockPushSubscription.upsert).not.toHaveBeenCalled();
  });

  it("refuses a malformed body without touching the database", async () => {
    const response = await POST(request("POST", "not json"));

    expect(response.status).toBe(400);
    expect(mockPushSubscription.upsert).not.toHaveBeenCalled();
  });

  it("says so when the instance has no VAPID keys", async () => {
    mockIsPushConfigured.mockReturnValue(false);

    const response = await POST(request("POST", subscription));

    expect(response.status).toBe(503);
    expect(mockPushSubscription.upsert).not.toHaveBeenCalled();
  });

  it("removes only the signed-in user's subscription", async () => {
    const response = await DELETE(request("DELETE", { endpoint: ENDPOINT }));

    expect(response.status).toBe(200);
    expect(mockPushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, endpoint: ENDPOINT },
    });
  });

  it("requires a session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await POST(request("POST", subscription));

    expect(response.status).toBe(401);
    expect(mockPushSubscription.upsert).not.toHaveBeenCalled();
  });
});
