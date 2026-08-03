import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockBufferEvent = vi.fn().mockResolvedValue(1);
const mockClearBuffer = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/pi/sse-buffer", () => ({
  bufferEvent: (...args: unknown[]) => mockBufferEvent(...args),
  clearBuffer: (...args: unknown[]) => mockClearBuffer(...args),
}));

// A fake Redis subscriber connection (createRedisClient) and publisher (getRedis).
const subscriberHandlers: Record<string, Set<(channel: string, message: string) => void>> = {};
const mockSubscribe = vi.fn().mockResolvedValue("OK");
const mockUnsubscribe = vi.fn().mockResolvedValue("OK");
const mockOn = vi.fn((event: string, handler: (channel: string, message: string) => void) => {
  if (event === "message") {
    subscriberHandlers.message ??= new Set();
    subscriberHandlers.message.add(handler);
  }
  return subscriberClient;
});
const subscriberClient = { on: mockOn, subscribe: mockSubscribe, unsubscribe: mockUnsubscribe };

const mockPublish = vi.fn().mockResolvedValue(1);
const mockGetRedis = vi.fn().mockReturnValue({ publish: mockPublish });
const mockCreateRedisClient = vi.fn().mockReturnValue(subscriberClient);
vi.mock("@/lib/redis", () => ({
  getRedis: () => mockGetRedis(),
  createRedisClient: () => mockCreateRedisClient(),
}));

import {
  publishSessionEvent,
  subscribeSessionEvents,
  resetSessionEvents,
} from "@/lib/pi/session-events";

/** Deliver a pub/sub message to the shared subscriber as Redis would. */
function deliverMessage(channel: string, payload: string) {
  for (const handler of subscriberHandlers.message ?? []) {
    handler(channel, payload);
  }
}

describe("session-events bus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBufferEvent.mockResolvedValue(1);
    mockClearBuffer.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue(1);
    // NOTE: do NOT clear subscriberHandlers.message — the module-level
    // subscriber connection (and its message handler) persists across tests
    // within this file; deliverMessage must keep reaching it.
  });

  describe("publishSessionEvent", () => {
    it("buffers the event and publishes it to the session channel", async () => {
      mockBufferEvent.mockResolvedValueOnce(42);

      const id = await publishSessionEvent("session-1", "token", { text: "hello" });

      expect(mockBufferEvent).toHaveBeenCalledWith("session-1", "token", { text: "hello" });
      expect(mockPublish).toHaveBeenCalledWith(
        "chat:events:session-1",
        JSON.stringify({ id: 42, event: "token", data: { text: "hello" } }),
      );
      expect(id).toBe(42);
    });

    it("survives a publish failure (buffering still succeeded)", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockPublish.mockRejectedValueOnce(new Error("Redis down"));

      const id = await publishSessionEvent("session-1", "done", {});

      expect(id).toBe(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to publish session event"),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("subscribeSessionEvents", () => {
    it("subscribes the shared connection to the session channel", async () => {
      const listener = vi.fn();
      const unsubscribe = await subscribeSessionEvents("session-1", listener);

      expect(mockCreateRedisClient).toHaveBeenCalledTimes(1);
      expect(mockSubscribe).toHaveBeenCalledWith("chat:events:session-1");

      unsubscribe();
      expect(mockUnsubscribe).toHaveBeenCalledWith("chat:events:session-1");
    });

    it("delivers live events to the listener", async () => {
      const listener = vi.fn();
      const unsubscribe = await subscribeSessionEvents("session-1", listener);

      deliverMessage(
        "chat:events:session-1",
        JSON.stringify({ id: 5, event: "token", data: { text: "x" } }),
      );

      expect(listener).toHaveBeenCalledWith({ id: 5, event: "token", data: { text: "x" } });
      unsubscribe();
    });

    it("refcounts: one Redis subscription for many local listeners", async () => {
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = await subscribeSessionEvents("session-1", a);
      const unsubB = await subscribeSessionEvents("session-1", b);

      // Both listeners registered; only ONE channel subscription.
      expect(mockSubscribe).toHaveBeenCalledTimes(1);

      deliverMessage("chat:events:session-1", JSON.stringify({ id: 1, event: "done", data: {} }));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);

      // Re-subscribing the same session does not add another Redis subscription.
      const unsubC = await subscribeSessionEvents("session-1", vi.fn());
      unsubC();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);

      unsubA();
      unsubB();
    });

    it("unsubscribes the channel only when the last listener leaves", async () => {
      const a = vi.fn();
      const unsubA = await subscribeSessionEvents("session-1", a);
      const unsubB = await subscribeSessionEvents("session-1", vi.fn());

      unsubA();
      expect(mockUnsubscribe).not.toHaveBeenCalled();

      unsubB();
      expect(mockUnsubscribe).toHaveBeenCalledWith("chat:events:session-1");
    });

    it("does not deliver events to unsubscribed listeners", async () => {
      const listener = vi.fn();
      const unsubscribe = await subscribeSessionEvents("session-1", listener);

      unsubscribe();
      deliverMessage("chat:events:session-1", JSON.stringify({ id: 1, event: "done", data: {} }));

      expect(listener).not.toHaveBeenCalled();
    });

    it("isolates channels per session", async () => {
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      const unsubA = await subscribeSessionEvents("session-a", listenerA);
      const unsubB = await subscribeSessionEvents("session-b", listenerB);

      deliverMessage("chat:events:session-a", JSON.stringify({ id: 1, event: "done", data: {} }));

      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).not.toHaveBeenCalled();

      unsubA();
      unsubB();
    });

    it("survives a subscribe failure (caller relies on buffer replay)", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockSubscribe.mockRejectedValueOnce(new Error("Redis down"));

      const listener = vi.fn();
      await expect(subscribeSessionEvents("session-1", listener)).resolves.toBeTypeOf("function");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to subscribe to session events"),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("resetSessionEvents", () => {
    it("clears the buffer", async () => {
      await resetSessionEvents("session-1");
      expect(mockClearBuffer).toHaveBeenCalledWith("session-1");
    });
  });
});
