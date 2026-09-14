import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Wiring rules that keep a run's persistence intact:
 *  - a new run replaces the previous run's tracker (which is tearing down
 *    asynchronously after publishing `done`),
 *  - a superseded tracker must not delete the new one's registration,
 *  - `waitForPersistenceTeardown` unblocks callers even when a tracker is
 *    disposed (pool eviction) instead of settling.
 */

const { mockCreateTracker, trackers } = vi.hoisted(() => {
  const trackers: Array<{
    sessionId: string;
    dispose: ReturnType<typeof vi.fn>;
    onDone?: () => void;
  }> = [];
  const mockCreateTracker = vi.fn((opts: { sessionId: string; onDone?: () => void }) => {
    const dispose = vi.fn();
    const tracker = {
      sessionId: opts.sessionId,
      dispose,
      ...(opts.onDone ? { onDone: opts.onDone } : {}),
    };
    trackers.push(tracker);
    return { dispose };
  });
  return { mockCreateTracker, trackers };
});

vi.mock("@/lib/pi/session-event-tracker", () => ({
  createSessionEventTracker: mockCreateTracker,
}));

import {
  unwireSessionPersistence,
  waitForPersistenceTeardown,
  wireSessionPersistence,
} from "@/lib/pi/session-persistence";

const SESSION_ID = "session-1";
const fakeSession = {} as Parameters<typeof wireSessionPersistence>[2];

beforeEach(() => {
  vi.clearAllMocks();
  trackers.length = 0;
  // The store is module state shared across the file — clean it up.
  unwireSessionPersistence(SESSION_ID);
});

describe("wireSessionPersistence", () => {
  it("wires a tracker for the session", () => {
    wireSessionPersistence(SESSION_ID, "user-1", fakeSession);

    expect(mockCreateTracker).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, userId: "user-1" }),
    );
  });

  it("replaces (and disposes) the previous run's tracker", () => {
    wireSessionPersistence(SESSION_ID, "user-1", fakeSession);
    wireSessionPersistence(SESSION_ID, "user-1", fakeSession);

    expect(trackers).toHaveLength(2);
    expect(trackers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(trackers[1]!.dispose).not.toHaveBeenCalled();
  });

  it("ignores `done` from a tracker that was already replaced", () => {
    wireSessionPersistence(SESSION_ID, "user-1", fakeSession);
    const stale = trackers[0]!;

    wireSessionPersistence(SESSION_ID, "user-1", fakeSession);
    stale.onDone?.(); // the old run finishes its teardown late

    expect(mockCreateTracker).toHaveBeenCalledTimes(2);
    // The new registration survives, so the next run still wires a tracker.
    wireSessionPersistence(SESSION_ID, "user-1", fakeSession);
    expect(mockCreateTracker).toHaveBeenCalledTimes(3);
    expect(trackers[1]!.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("waitForPersistenceTeardown", () => {
  it("resolves immediately when nothing is wired", async () => {
    await expect(waitForPersistenceTeardown(SESSION_ID)).resolves.toBeUndefined();
  });

  it("waits until the run published done and unsubscribed", async () => {
    wireSessionPersistence(SESSION_ID, "user-1", fakeSession);
    let released = false;
    const waiting = waitForPersistenceTeardown(SESSION_ID).then(() => {
      released = true;
    });

    await Promise.resolve();
    expect(released).toBe(false);

    trackers[0]!.onDone?.();
    await waiting;
    expect(released).toBe(true);
  });

  it("does not hang when the tracker is disposed instead of settling", async () => {
    wireSessionPersistence(SESSION_ID, "user-1", fakeSession);
    const waiting = waitForPersistenceTeardown(SESSION_ID);

    unwireSessionPersistence(SESSION_ID);

    await expect(waiting).resolves.toBeUndefined();
  });
});
