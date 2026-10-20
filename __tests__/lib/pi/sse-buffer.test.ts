import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Redis mocks ────────────────────────────────────────────────────────────

const mockRedisIncr = vi.fn().mockResolvedValue(1);
const mockRedisExpire = vi.fn().mockResolvedValue(1);
const mockRedisZadd = vi.fn().mockResolvedValue(true);
const mockRedisZremrangebyrank = vi.fn().mockResolvedValue(0);
const mockRedisZrangebyscore = vi.fn().mockResolvedValue([]);
const mockRedisDel = vi.fn().mockResolvedValue(1);

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    zadd: mockRedisZadd,
    zremrangebyrank: mockRedisZremrangebyrank,
    zrangebyscore: mockRedisZrangebyscore,
    del: mockRedisDel,
  }),
}));

import { nextEventId, bufferEvent, getBufferedEvents, clearBuffer } from "@/lib/pi/sse-buffer";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePayload(id: number, event: string, data: unknown): string {
  return JSON.stringify({ id, event, data });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("nextEventId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisIncr.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(1);
  });

  it("returns incrementing IDs", async () => {
    mockRedisIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);

    expect(await nextEventId("session-1")).toBe(1);
    expect(await nextEventId("session-1")).toBe(2);
    expect(await nextEventId("session-1")).toBe(3);
  });

  it("sets a long TTL on counter key so IDs never reset mid-generation", async () => {
    await nextEventId("session-1");

    expect(mockRedisIncr).toHaveBeenCalledWith("chat:sse:buf:session-1:counter");
    // 24h: a tool call can run for many minutes without emitting events. If
    // the counter expired, IDs would restart at 1 and clients holding a
    // higher Last-Event-ID would silently skip every new event.
    expect(mockRedisExpire).toHaveBeenCalledWith("chat:sse:buf:session-1:counter", 86400);
  });

  it("uses separate counters per session", async () => {
    mockRedisIncr.mockResolvedValue(1);

    await nextEventId("session-a");
    await nextEventId("session-b");

    expect(mockRedisIncr).toHaveBeenCalledWith("chat:sse:buf:session-a:counter");
    expect(mockRedisIncr).toHaveBeenCalledWith("chat:sse:buf:session-b:counter");
  });
});

describe("bufferEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisIncr.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(1);
    mockRedisZadd.mockResolvedValue(true);
    mockRedisZremrangebyrank.mockResolvedValue(0);
  });

  it("stores event in sorted set with ID as score", async () => {
    const id = await bufferEvent("session-1", "token", { text: "hello" });

    expect(id).toBe(1);
    const expectedPayload = makePayload(1, "token", { text: "hello" });
    expect(mockRedisZadd).toHaveBeenCalledWith("chat:sse:buf:session-1", 1, expectedPayload);
  });

  it("returns the assigned ID", async () => {
    mockRedisIncr.mockResolvedValue(42);
    const id = await bufferEvent("session-1", "done", {});
    expect(id).toBe(42);
  });

  it("trims buffer to max size", async () => {
    await bufferEvent("session-1", "token", { text: "hello" });

    expect(mockRedisZremrangebyrank).toHaveBeenCalledWith("chat:sse:buf:session-1", 0, -(500 + 1));
  });

  it("sets TTL on buffer key", async () => {
    await bufferEvent("session-1", "token", { text: "hello" });

    expect(mockRedisExpire).toHaveBeenCalledWith("chat:sse:buf:session-1", 1800);
  });

  it("handles Redis errors gracefully", async () => {
    mockRedisIncr.mockRejectedValueOnce(new Error("Redis down"));

    // Should not throw  the error is caught and logged
    await expect(bufferEvent("session-1", "token", { text: "hello" })).rejects.toThrow(
      "Redis down",
    );
  });
});

describe("getBufferedEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisZrangebyscore.mockResolvedValue([]);
  });

  it("returns events with ID > lastEventId", async () => {
    const events = [
      makePayload(3, "token", { text: "third" }),
      makePayload(4, "token", { text: "fourth" }),
    ];
    mockRedisZrangebyscore.mockResolvedValueOnce(events);

    const result = await getBufferedEvents("session-1", 2);

    expect(mockRedisZrangebyscore).toHaveBeenCalledWith(
      "chat:sse:buf:session-1",
      3, // lastEventId + 1
      "+inf",
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 3, event: "token", data: { text: "third" } });
    expect(result[1]).toEqual({ id: 4, event: "token", data: { text: "fourth" } });
  });

  it("returns all events when lastEventId is -1", async () => {
    const events = [
      makePayload(1, "token", { text: "first" }),
      makePayload(2, "thinking", { thinking: "reasoning" }),
    ];
    mockRedisZrangebyscore.mockResolvedValueOnce(events);

    const result = await getBufferedEvents("session-1", -1);

    expect(mockRedisZrangebyscore).toHaveBeenCalledWith(
      "chat:sse:buf:session-1",
      0, // -1 + 1 = 0
      "+inf",
    );
    expect(result).toHaveLength(2);
  });

  it("returns events in order (oldest first)", async () => {
    // zrangebyscore returns in ascending score order by default
    const events = [
      makePayload(1, "token", { text: "first" }),
      makePayload(2, "token", { text: "second" }),
      makePayload(3, "done", {}),
    ];
    mockRedisZrangebyscore.mockResolvedValueOnce(events);

    const result = await getBufferedEvents("session-1", 0);

    expect(result[0]!.id).toBe(1);
    expect(result[1]!.id).toBe(2);
    expect(result[2]!.id).toBe(3);
  });

  it("returns empty array when no events", async () => {
    mockRedisZrangebyscore.mockResolvedValueOnce([]);

    const result = await getBufferedEvents("session-1", 0);
    expect(result).toEqual([]);
  });

  it("skips malformed entries gracefully", async () => {
    mockRedisZrangebyscore.mockResolvedValueOnce([
      "not-json",
      makePayload(1, "token", { text: "valid" }),
      "{broken",
    ]);

    const result = await getBufferedEvents("session-1", 0);

    // Only the valid entry should be returned
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 1, event: "token", data: { text: "valid" } });
  });

  it("handles Redis errors gracefully", async () => {
    mockRedisZrangebyscore.mockRejectedValueOnce(new Error("Redis down"));

    const result = await getBufferedEvents("session-1", 0);
    expect(result).toEqual([]);
  });

  it("handles non-string entries in result", async () => {
    // Some Redis drivers return numbers or nulls
    mockRedisZrangebyscore.mockResolvedValueOnce([
      null,
      makePayload(1, "token", { text: "valid" }),
      42,
    ]);

    const result = await getBufferedEvents("session-1", 0);
    expect(result).toHaveLength(1);
  });
});

describe("clearBuffer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisDel.mockResolvedValue(1);
  });

  it("deletes the buffer key but NOT the counter key", async () => {
    await clearBuffer("session-1");

    expect(mockRedisDel).toHaveBeenCalledWith("chat:sse:buf:session-1");
    // The counter is intentionally preserved so event IDs stay monotonic
    // across generations  clients reconnecting with a Last-Event-ID from a
    // previous generation must keep receiving newer events.
    expect(mockRedisDel).not.toHaveBeenCalledWith("chat:sse:buf:session-1:counter");
  });

  it("handles Redis errors gracefully", async () => {
    mockRedisDel.mockRejectedValueOnce(new Error("Redis down"));

    // Should not throw
    await expect(clearBuffer("session-1")).resolves.toBeUndefined();
  });
});

describe("SSE buffer lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisIncr.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(1);
    mockRedisZadd.mockResolvedValue(true);
    mockRedisZremrangebyrank.mockResolvedValue(0);
    mockRedisZrangebyscore.mockResolvedValue([]);
    mockRedisDel.mockResolvedValue(1);
  });

  it("full lifecycle: buffer events, read them back, clear", async () => {
    // Buffer three events
    mockRedisIncr.mockResolvedValue(1);
    const id1 = await bufferEvent("session-1", "token", { text: "hello" });
    expect(id1).toBe(1);

    mockRedisIncr.mockResolvedValue(2);
    const id2 = await bufferEvent("session-1", "thinking", { thinking: "reasoning" });
    expect(id2).toBe(2);

    mockRedisIncr.mockResolvedValue(3);
    const id3 = await bufferEvent("session-1", "done", {});
    expect(id3).toBe(3);

    // Read back events after ID 0 (all events)
    mockRedisZrangebyscore.mockResolvedValueOnce([
      makePayload(1, "token", { text: "hello" }),
      makePayload(2, "thinking", { thinking: "reasoning" }),
      makePayload(3, "done", {}),
    ]);
    const allEvents = await getBufferedEvents("session-1", 0);
    expect(allEvents).toHaveLength(3);

    // Read back events after ID 1 (skip first event)
    mockRedisZrangebyscore.mockResolvedValueOnce([
      makePayload(2, "thinking", { thinking: "reasoning" }),
      makePayload(3, "done", {}),
    ]);
    const afterFirst = await getBufferedEvents("session-1", 1);
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0]!.id).toBe(2);

    // Clear buffer (events only  counter survives)
    await clearBuffer("session-1");
    expect(mockRedisDel).toHaveBeenCalledWith("chat:sse:buf:session-1");
    expect(mockRedisDel).not.toHaveBeenCalledWith("chat:sse:buf:session-1:counter");
  });

  it("reconnect scenario: client reconnects with lastEventId", async () => {
    // Client had received up to event ID 5, then disconnected
    // Server has buffered events 1-10
    const bufferedEvents = Array.from({ length: 10 }, (_, i) =>
      makePayload(i + 1, "token", { text: `chunk-${i + 1}` }),
    );
    mockRedisZrangebyscore.mockResolvedValueOnce(
      bufferedEvents.slice(5), // events 6-10 (score > 5)
    );

    const result = await getBufferedEvents("session-1", 5);

    expect(result).toHaveLength(5);
    expect(result[0]!.id).toBe(6);
    expect(result[4]!.id).toBe(10);
  });
});
