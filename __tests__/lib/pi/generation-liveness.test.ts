import { describe, it, expect } from "vitest";
import { ACTIVE_SESSION_HEARTBEAT_MS, ACTIVE_SESSION_TTL_SECONDS } from "@/lib/redis";
import { isTerminalBufferedEvent } from "@/lib/pi/sse-buffer";

/**
 * The active-session flag is the only cross-process answer to "is this
 * generation still running?". It is a heartbeat, not a lock, and these are the
 * two constraints that keep that honest:
 *
 * - the TTL is short enough that a process dying mid-generation is noticed
 *   within seconds (a ten-minute flag is what left clients staring at a frozen
 *   stream after a restart), and
 * - the refresh cadence leaves room for several missed beats, so a live
 *   generation is never mistaken for a dead one.
 */
describe("generation liveness heartbeat", () => {
  it("notices a dead generation within a minute", () => {
    expect(ACTIVE_SESSION_TTL_SECONDS).toBeLessThanOrEqual(60);
  });

  it("survives several missed beats before a live run looks dead", () => {
    const beatsPerTtl = (ACTIVE_SESSION_TTL_SECONDS * 1000) / ACTIVE_SESSION_HEARTBEAT_MS;
    expect(beatsPerTtl).toBeGreaterThanOrEqual(3);
  });
});

describe("isTerminalBufferedEvent", () => {
  const event = (name: string) => ({ id: 1, event: name, data: {} });

  it("treats done and error as run-ending", () => {
    expect(isTerminalBufferedEvent(event("done"))).toBe(true);
    expect(isTerminalBufferedEvent(event("error"))).toBe(true);
  });

  it("treats in-flight events as non-terminal", () => {
    expect(isTerminalBufferedEvent(event("token"))).toBe(false);
    expect(isTerminalBufferedEvent(event("tool_start"))).toBe(false);
  });
});
