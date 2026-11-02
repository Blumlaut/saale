import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPushSubscription,
  mockSendNotification,
  mockVapid,
  mockScheduleMobilePush,
  mockWasPushSeenSince,
} = vi.hoisted(() => ({
  mockPushSubscription: { findMany: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn() },
  mockSendNotification: vi.fn(),
  mockVapid: vi.fn(),
  mockScheduleMobilePush: vi.fn(),
  mockWasPushSeenSince: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { pushSubscription: mockPushSubscription } }));
vi.mock("@/lib/push/config", () => ({
  getVapidConfig: mockVapid,
  getMobilePushDelayMs: () => 180_000,
}));
vi.mock("@/lib/push/deferred", () => ({ scheduleMobilePush: mockScheduleMobilePush }));
vi.mock("@/lib/push/seen", () => ({ wasPushSeenSince: mockWasPushSeenSince }));
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => mockSendNotification(...args),
  },
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { sendDeferredPush, sendPushToUser } from "@/lib/push/send";

const PAYLOAD = {
  title: "Finished responding",
  body: "Weekly planning",
  url: "/dashboard/chat/chat-1",
  tag: "chat-chat-1",
};

const computer = {
  id: "subscription-1",
  endpoint: "https://push.example.com/device-1",
  p256dh: "p256dh-key",
  auth: "auth-key",
  deviceKind: "desktop",
};

const phone = {
  id: "subscription-2",
  endpoint: "https://push.example.com/device-2",
  p256dh: "p256dh-key",
  auth: "auth-key",
  deviceKind: "mobile",
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
    mockPushSubscription.findMany.mockResolvedValue([computer]);
    mockPushSubscription.deleteMany.mockResolvedValue({ count: 1 });
    mockSendNotification.mockResolvedValue({ statusCode: 201 });
    mockScheduleMobilePush.mockResolvedValue(undefined);
  });

  it("sends the payload to every device of the user", async () => {
    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 1, deferred: 0, skipped: 0, pruned: 0, failed: 0 });
    expect(mockPushSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(mockSendNotification).toHaveBeenCalledWith(
      {
        endpoint: computer.endpoint,
        keys: { p256dh: computer.p256dh, auth: computer.auth },
      },
      JSON.stringify(PAYLOAD),
      expect.objectContaining({ TTL: expect.any(Number) }),
    );
  });

  it("gives the computer its copy now and holds the phone's", async () => {
    mockPushSubscription.findMany.mockResolvedValue([computer, phone]);

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 1, deferred: 1, skipped: 0, pruned: 0, failed: 0 });
    expect(mockScheduleMobilePush).toHaveBeenCalledWith("user-1", PAYLOAD);
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: computer.endpoint }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("sends to a phone at once when the user has no computer", async () => {
    mockPushSubscription.findMany.mockResolvedValue([phone]);

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 1, deferred: 0, skipped: 0, pruned: 0, failed: 0 });
    expect(mockScheduleMobilePush).not.toHaveBeenCalled();
  });

  it("sends to every device at once when the caller defers nothing", async () => {
    mockPushSubscription.findMany.mockResolvedValue([computer, phone]);

    const delivery = await sendPushToUser("user-1", PAYLOAD, { deferMobile: false });

    expect(delivery).toEqual({ sent: 2, deferred: 0, skipped: 0, pruned: 0, failed: 0 });
    expect(mockScheduleMobilePush).not.toHaveBeenCalled();
  });

  it("sends to the phone now when the queue will not take the delayed job", async () => {
    mockPushSubscription.findMany.mockResolvedValue([computer, phone]);
    mockScheduleMobilePush.mockRejectedValue(new Error("redis is down"));

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 2, deferred: 0, skipped: 0, pruned: 0, failed: 0 });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("drops a subscription the push service reports as gone", async () => {
    mockSendNotification.mockRejectedValue(pushError(410));

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 0, deferred: 0, skipped: 0, pruned: 1, failed: 0 });
    expect(mockPushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: computer.id, userId: "user-1" },
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("logs a device that failed for another reason, and keeps it", async () => {
    mockSendNotification.mockRejectedValue(pushError(500));

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 0, deferred: 0, skipped: 0, pruned: 0, failed: 1 });
    expect(mockPushSubscription.deleteMany).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("does nothing when the instance has no VAPID keys", async () => {
    mockVapid.mockReturnValue(null);

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery).toEqual({ sent: 0, deferred: 0, skipped: 0, pruned: 0, failed: 0 });
    expect(mockPushSubscription.findMany).not.toHaveBeenCalled();
  });

  it("needs no push call when the user has no subscribed device", async () => {
    mockPushSubscription.findMany.mockResolvedValue([]);

    const delivery = await sendPushToUser("user-1", PAYLOAD);

    expect(delivery.sent).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});

describe("sendDeferredPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVapid.mockReturnValue({
      publicKey: "public",
      privateKey: "private",
      subject: "mailto:a@b",
    });
    mockPushSubscription.deleteMany.mockResolvedValue({ count: 1 });
    mockSendNotification.mockResolvedValue({ statusCode: 201 });
    mockWasPushSeenSince.mockResolvedValue(false);
  });

  it("sends to the phones that are still subscribed", async () => {
    mockPushSubscription.findMany.mockResolvedValue([phone]);

    const delivery = await sendDeferredPush("user-1", PAYLOAD, 1_000);

    expect(delivery).toEqual({ sent: 1, deferred: 0, skipped: 0, pruned: 0, failed: 0 });
    expect(mockPushSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", deviceKind: "mobile" } }),
    );
    expect(mockWasPushSeenSince).toHaveBeenCalledWith("user-1", PAYLOAD.url, 1_000);
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: phone.endpoint }),
      JSON.stringify(PAYLOAD),
      expect.any(Object),
    );
  });

  it("leaves the phones alone when the page was on screen since it was queued", async () => {
    mockPushSubscription.findMany.mockResolvedValue([phone]);
    mockWasPushSeenSince.mockResolvedValue(true);

    const delivery = await sendDeferredPush("user-1", PAYLOAD, 1_000);

    expect(delivery).toEqual({ sent: 0, deferred: 0, skipped: 1, pruned: 0, failed: 0 });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("does nothing when every phone turned notifications off", async () => {
    mockPushSubscription.findMany.mockResolvedValue([]);

    const delivery = await sendDeferredPush("user-1", PAYLOAD);

    expect(delivery.sent).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
