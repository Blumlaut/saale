import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Redis mocks ────────────────────────────────────────────────────────────
//
// The buffer talks to Redis through two MULTI transactions per buffered event
// (counter increment, then sorted-set write), so the mock records each
// transaction as a chain of commands and resolves exec() with results for
// them.

interface FakeChain {
  commands: Array<[command: string, args: unknown[]]>;
  incr: (...args: unknown[]) => FakeChain;
  expire: (...args: unknown[]) => FakeChain;
  zadd: (...args: unknown[]) => FakeChain;
  zremrangebyrank: (...args: unknown[]) => FakeChain;
  exec: ReturnType<typeof vi.fn>;
}

const chains: FakeChain[] = [];
let nextId = 1;

function makeChain(): FakeChain {
  const commands: FakeChain["commands"] = [];
  const chain: FakeChain = {
    commands,
    incr: (...args) => {
      commands.push(["incr", args]);
      return chain;
    },
    expire: (...args) => {
      commands.push(["expire", args]);
      return chain;
    },
    zadd: (...args) => {
      commands.push(["zadd", args]);
      return chain;
    },
    zremrangebyrank: (...args) => {
      commands.push(["zremrangebyrank", args]);
      return chain;
    },
    exec: vi.fn().mockImplementation(async () => {
      // ioredis resolves exec() with [error, value] pairs, one per command.
      return Promise.all(
        commands.map(([command]) => {
          if (command === "incr") return [null, nextId++];
          if (command === "expire") return [null, 1];
          if (command === "zadd") return [null, true];
          return [null, 0];
        }),
      );
    }),
  };
  return chain;
}

const mockRedisMulti = vi.fn(() => {
  const chain = makeChain();
  chains.push(chain);
  return chain;
});
const mockRedisZrangebyscore = vi.fn().mockResolvedValue([]);
const mockRedisDel = vi.fn().mockResolvedValue(1);

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    multi: mockRedisMulti,
    zrangebyscore: mockRedisZrangebyscore,
    del: mockRedisDel,
  }),
}));

import { bufferEvent, getBufferedEvents, clearBuffer } from "@/lib/pi/sse-buffer";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePayload(id: number, event: string, data: unknown): string {
  return JSON.stringify({ id, event, data });
}

/** All commands recorded so far, with the issuing chain index. */
function recordedCommands(): Array<{ chain: number; command: string; args: unknown[] }> {
  return chains.flatMap((chain, chainIndex) =>
    chain.commands.map((entry) => ({ chain: chainIndex, command: entry[0], args: entry[1] })),
  );
}

/** Buffer one event, advancing the clock first so cumulative snapshots are not throttled. */
async function bufferEventNoThrottle(
  sessionId: string,
  event: string,
  data: unknown,
): Promise<number> {
  vi.advanceTimersByTime(1100);
  return bufferEvent(sessionId, event, data);
}

beforeEach(() => {
  vi.clearAllMocks();
  chains.length = 0;
  nextId = 1;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  mockRedisZrangebyscore.mockResolvedValue([]);
  mockRedisDel.mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("nextEventId (via bufferEvent)", () => {
  it("increments the per-session counter and refreshes its TTL in one transaction", async () => {
    await bufferEvent("session-1", "done", {});

    // The "done" event is not throttled, so two transactions: counter, then write.
    expect(chains).toHaveLength(2);
    expect(chains[0]!.commands).toEqual([
      ["incr", ["chat:sse:buf:session-1:counter"]],
      ["expire", ["chat:sse:buf:session-1:counter", 86400]],
    ]);
    // 24h: a tool call can run for many minutes without emitting events. If
    // the counter expired, IDs would restart at 1 and clients holding a
    // higher Last-Event-ID would silently skip every new event.
  });

  it("returns incrementing IDs", async () => {
    expect(await bufferEventNoThrottle("s-incr-a", "token", { text: "a" })).toBe(1);
    expect(await bufferEventNoThrottle("s-incr-a", "token", { text: "b" })).toBe(2);
    expect(await bufferEventNoThrottle("s-incr-a", "token", { text: "c" })).toBe(3);
  });

  it("uses separate counters per session", async () => {
    await bufferEventNoThrottle("session-a", "done", {});
    await bufferEventNoThrottle("session-b", "done", {});

    const incrKeys = recordedCommands()
      .filter((c) => c.command === "incr")
      .map((c) => c.args[0]);
    expect(incrKeys).toEqual(["chat:sse:buf:session-a:counter", "chat:sse:buf:session-b:counter"]);
  });
});

describe("bufferEvent", () => {
  it("stores event in sorted set with ID as score, trimmed, TTL refreshed. one transaction", async () => {
    const id = await bufferEvent("s-store", "token", { text: "hello" });

    expect(id).toBe(1);
    expect(chains).toHaveLength(2);
    expect(chains[1]!.commands).toEqual([
      ["zadd", ["chat:sse:buf:s-store", 1, makePayload(1, "token", { text: "hello" })]],
      ["zremrangebyrank", ["chat:sse:buf:s-store", 0, -(500 + 1)]],
      ["expire", ["chat:sse:buf:s-store", 1800]],
    ]);
  });

  it("returns the assigned ID", async () => {
    const id = await bufferEvent("s-return-id", "done", {});
    expect(id).toBe(1);
  });

  it("still assigns an ID to a skipped cumulative snapshot, without writing the buffer", async () => {
    expect(await bufferEvent("s-skip", "token", { text: "first" })).toBe(1);
    // Inside the 1s window: ID advances, no sorted-set write.
    const id = await bufferEvent("s-skip", "token", { text: "second" });
    expect(id).toBe(2);
    // First token: counter + write. Second (throttled): counter only.
    expect(chains).toHaveLength(3);
    expect(chains[2]!.commands).toEqual([
      ["incr", ["chat:sse:buf:s-skip:counter"]],
      ["expire", ["chat:sse:buf:s-skip:counter", 86400]],
    ]);
  });

  it("buffers a new cumulative snapshot once the interval has passed", async () => {
    await bufferEvent("s-interval", "token", { text: "first" });
    vi.advanceTimersByTime(1000);
    await bufferEvent("s-interval", "token", { text: "second" });
    expect(chains).toHaveLength(4); // counter + write, twice
    expect(chains[3]!.commands[0]).toEqual([
      "zadd",
      ["chat:sse:buf:s-interval", 2, makePayload(2, "token", { text: "second" })],
    ]);
  });

  it("never throttles non-cumulative events, even back to back", async () => {
    await bufferEvent("s-nottl", "tool_start", { toolCallId: "1" });
    await bufferEvent("s-nottl", "tool_end", { toolCallId: "1" });
    await bufferEvent("s-nottl", "done", {});
    expect(chains).toHaveLength(6); // counter + write for each
  });

  it("throttles per session, not globally", async () => {
    await bufferEvent("s-thr-a", "token", { text: "a" });
    await bufferEvent("s-thr-b", "token", { text: "b" });
    expect(chains).toHaveLength(4); // both buffered
  });
});

describe("getBufferedEvents", () => {
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
  it("deletes the buffer key but NOT the counter key", async () => {
    await clearBuffer("session-1");

    expect(mockRedisDel).toHaveBeenCalledWith("chat:sse:buf:session-1");
    // The counter is intentionally preserved so event IDs stay monotonic
    // across generations  clients reconnecting with a Last-Event-ID from a
    // previous generation must keep receiving newer events.
    expect(mockRedisDel).not.toHaveBeenCalledWith("chat:sse:buf:session-1:counter");
  });

  it("forgets the throttle state so the next generation's first snapshot is buffered", async () => {
    await bufferEvent("s-new-gen", "token", { text: "first" });
    // A second generation starting inside the throttle window: without the
    // reset its first cumulative snapshot would be dropped from the (already
    // cleared) buffer, leaving a reconnecting client nothing to replay.
    await clearBuffer("s-new-gen");
    await bufferEvent("s-new-gen", "token", { text: "second" });

    const writes = recordedCommands().filter((c) => c.command === "zadd");
    expect(writes).toHaveLength(2);
    expect(writes[1]!.args[2]).toBe(makePayload(2, "token", { text: "second" }));
  });

  it("handles Redis errors gracefully", async () => {
    mockRedisDel.mockRejectedValueOnce(new Error("Redis down"));

    // Should not throw
    await expect(clearBuffer("session-1")).resolves.toBeUndefined();
  });
});

describe("SSE buffer lifecycle", () => {
  it("full lifecycle: buffer events, read them back, clear", async () => {
    // Buffer three events (spaced out so cumulative snapshots are not throttled)
    const id1 = await bufferEventNoThrottle("s-lifecycle", "token", { text: "hello" });
    expect(id1).toBe(1);
    const id2 = await bufferEventNoThrottle("s-lifecycle", "tool_end", { toolCallId: "t1" });
    expect(id2).toBe(2);
    const id3 = await bufferEventNoThrottle("s-lifecycle", "done", {});
    expect(id3).toBe(3);

    // Read back events after ID 0 (all events)
    mockRedisZrangebyscore.mockResolvedValueOnce([
      makePayload(1, "token", { text: "hello" }),
      makePayload(2, "tool_end", { toolCallId: "t1" }),
      makePayload(3, "done", {}),
    ]);
    const allEvents = await getBufferedEvents("s-lifecycle", 0);
    expect(allEvents).toHaveLength(3);

    // Read back events after ID 1 (skip first event)
    mockRedisZrangebyscore.mockResolvedValueOnce([
      makePayload(2, "tool_end", { toolCallId: "t1" }),
      makePayload(3, "done", {}),
    ]);
    const afterFirst = await getBufferedEvents("s-lifecycle", 1);
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0]!.id).toBe(2);

    // Clear buffer (events only  counter survives)
    await clearBuffer("s-lifecycle");
    expect(mockRedisDel).toHaveBeenCalledWith("chat:sse:buf:s-lifecycle");
    expect(mockRedisDel).not.toHaveBeenCalledWith("chat:sse:buf:s-lifecycle:counter");
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
