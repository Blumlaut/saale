import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPushSubscription, mockSendNotification, mockVapid } = vi.hoisted(() => ({
  mockPushSubscription: { findMany: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn() },
  mockSendNotification: vi.fn(),
  mockVapid: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { pushSubscription: mockPushSubscription } }));
vi.mock("@/lib/push/config", () => ({ getVapidConfig: mockVapid }));
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => mockSendNotification(...args),
  },
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { sendPushToUser } from "@/lib/push/send";

const PAYLOAD = {
  title: "Finished responding",
  body: "Weekly planning",
  url: "/dashboard/chat/chat-1",
  tag: "chat-chat-1",
};

const subscription = {
  id: "subscription-1",
  endpoint: "https://push.example.com/device-1",
  p256dh: "p256dh-key",
  auth: "auth-key",
};

/** A web-push failure carries the push service's status code. */
function pushError(statusCode: number): Error {
  return Object.assign(new Error(`push failed with ${statusCode}`), { statusCode });
}

describe("sendPushToUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVapid.mockReturnValue({
      publicKey: "public",
      privateKey: "private",
      subject: "mailto:a@b",
    });
    mockPushSubscription.findMany.mockResolvedValue([subscription]);
    mockPushSubscription.deleteMany.mockResolvedValue({ count: 1 });
    mockSendNotification.mockResolvedValue({ statusCode: 201 });
  });

  it("sends the payload to every device of the user", async () => {
    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 1, pruned: 0, failed: 0 });
    expect(mockPushSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(mockSendNotification).toHaveBeenCalledWith(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(PAYLOAD),
      expect.objectContaining({ TTL: expect.any(Number) }),
    );
  });

  it("drops a subscription the push service reports as gone", async () => {
    mockSendNotification.mockRejectedValue(pushError(410));

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 0, pruned: 1, failed: 0 });
    expect(mockPushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: "subscription-1", userId: "user-1" },
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("logs a device that failed for another reason, and keeps it", async () => {
    mockSendNotification.mockRejectedValue(pushError(500));

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 0, pruned: 0, failed: 1 });
    expect(mockPushSubscription.deleteMany).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("does nothing when the instance has no VAPID keys", async () => {
    mockVapid.mockReturnValue(null);

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 0, pruned: 0, failed: 0 });
    expect(mockPushSubscription.findMany).not.toHaveBeenCalled();
  });

  it("needs no push call when the user has no subscribed device", async () => {
    mockPushSubscription.findMany.mockResolvedValue([]);

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery.sent).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
