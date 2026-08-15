import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createAgentIdleTimeout } from "@/lib/pi/agent-idle-timeout";

/**
 * Minimal session double matching the `subscribe` contract used by
 * createAgentIdleTimeout: keeps listeners and lets tests emit events.
 */
function createMockSession() {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  return {
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Emit a fake event to every subscribed listener. */
    emit: () => {
      const event: AgentSessionEvent = { type: "agent_start" };
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    listenerCount: () => listeners.size,
  };
}

describe("createAgentIdleTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fires onTimeout when the session stays silent for the full window", () => {
    const session = createMockSession();
    const onTimeout = vi.fn();
    createAgentIdleTimeout({ session, timeoutMs: 10_000, label: "test", onTimeout });

    vi.advanceTimersByTime(9_999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("resets the window on every event, so an active agent outlives the window", () => {
    const session = createMockSession();
    const onTimeout = vi.fn();
    createAgentIdleTimeout({ session, timeoutMs: 10_000, label: "test", onTimeout });

    // The agent "works" for 60s, emitting an event every 2s — six times
    // longer than the 10s idle window in total run time.
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(2_000);
      session.emit();
    }
    expect(onTimeout).not.toHaveBeenCalled();

    // Once activity stops, a full window of silence triggers the timeout.
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("fires at most once and detaches its listener after firing", () => {
    const session = createMockSession();
    const onTimeout = vi.fn();
    createAgentIdleTimeout({ session, timeoutMs: 10_000, label: "test", onTimeout });

    vi.advanceTimersByTime(60_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(session.listenerCount()).toBe(0);

    // Late events after the timeout must not re-arm it.
    session.emit();
    vi.advanceTimersByTime(60_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("clear() stops the timer and detaches the listener", () => {
    const session = createMockSession();
    const onTimeout = vi.fn();
    const idle = createAgentIdleTimeout({
      session,
      timeoutMs: 10_000,
      label: "test",
      onTimeout,
    });

    idle.clear();
    expect(session.listenerCount()).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("clear() is idempotent and late events do not re-arm the timer", () => {
    const session = createMockSession();
    const onTimeout = vi.fn();
    const idle = createAgentIdleTimeout({
      session,
      timeoutMs: 10_000,
      label: "test",
      onTimeout,
    });

    idle.clear();
    idle.clear();

    // e.g. a trailing agent_settled event after the run finished
    session.emit();
    vi.advanceTimersByTime(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("noteActivity() resets the window manually", () => {
    const session = createMockSession();
    const onTimeout = vi.fn();
    const idle = createAgentIdleTimeout({
      session,
      timeoutMs: 10_000,
      label: "test",
      onTimeout,
    });

    vi.advanceTimersByTime(8_000);
    idle.noteActivity();
    vi.advanceTimersByTime(8_000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
