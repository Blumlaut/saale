import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetQueue, mockQueue, mockDelay } = vi.hoisted(() => ({
  mockGetQueue: vi.fn(),
  mockQueue: { getJob: vi.fn(), add: vi.fn(), remove: vi.fn() },
  mockDelay: vi.fn(),
}));

vi.mock("@/lib/queue", () => ({ getQueue: mockGetQueue }));
vi.mock("@/lib/push/config", () => ({ getMobilePushDelayMs: mockDelay }));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { MOBILE_PUSH_JOB_NAME, scheduleMobilePush } from "@/lib/push/deferred";

const PAYLOAD = {
  title: "New mail in me@example.com",
  body: "Ada: Lunch?",
  url: "/dashboard/mail",
  tag: "mail-account-1",
};

describe("scheduleMobilePush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQueue.mockReturnValue(mockQueue);
    mockDelay.mockReturnValue(180_000);
    mockQueue.getJob.mockResolvedValue(null);
    mockQueue.add.mockResolvedValue({});
  });

  it("queues the phone's copy behind the delay", async () => {
    await scheduleMobilePush("user-1", PAYLOAD);

    expect(mockQueue.add).toHaveBeenCalledWith(
      MOBILE_PUSH_JOB_NAME,
      { userId: "user-1", payload: PAYLOAD, queuedAt: expect.any(Number) },
      expect.objectContaining({ delay: 180_000, removeOnComplete: true }),
    );
  });

  it("keeps one pending push per tag, its timer, and its queued time", async () => {
    const pending = { data: { queuedAt: 1_000 }, updateData: vi.fn().mockResolvedValue(undefined) };
    mockQueue.getJob.mockResolvedValue(pending);

    const newer = { ...PAYLOAD, body: "Ada: Lunch? · and 2 more" };
    await scheduleMobilePush("user-1", newer);

    expect(pending.updateData).toHaveBeenCalledWith({
      userId: "user-1",
      payload: newer,
      queuedAt: 1_000,
    });
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it("queues a new push when nothing was waiting any more", async () => {
    const pending = { data: {}, updateData: vi.fn().mockRejectedValue(new Error("missing job")) };
    mockQueue.getJob.mockResolvedValue(pending);

    await scheduleMobilePush("user-1", PAYLOAD);

    expect(mockQueue.add).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
