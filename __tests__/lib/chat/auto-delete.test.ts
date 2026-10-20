import { describe, it, expect } from "vitest";
import { AUTO_DELETE_MIN_MOUNT_MS, shouldAutoDeleteSession } from "@/lib/chat/auto-delete";

const settled = { mountedForMs: AUTO_DELETE_MIN_MOUNT_MS + 1000 };

/** A quiet, non-temporary, empty session  the "abandoned new chat" case. */
const base = {
  temporary: false,
  messageCount: 0,
  hasDraft: false,
  busy: false,
  queuedCount: 0,
  ...settled,
};

describe("shouldAutoDeleteSession", () => {
  it("deletes a temporary session on leave, with or without messages", () => {
    expect(shouldAutoDeleteSession({ ...base, temporary: true })).toBe(true);
    expect(shouldAutoDeleteSession({ ...base, temporary: true, messageCount: 7 })).toBe(true);
    // Temporary is the privacy feature  a draft does not keep it alive.
    expect(shouldAutoDeleteSession({ ...base, temporary: true, hasDraft: true })).toBe(true);
  });

  it("deletes a non-temporary session only when it was never started", () => {
    expect(shouldAutoDeleteSession(base)).toBe(true);
    // An unsent draft is user content  the session must survive.
    expect(shouldAutoDeleteSession({ ...base, hasDraft: true })).toBe(false);
    // Any real conversation persists.
    expect(shouldAutoDeleteSession({ ...base, messageCount: 1 })).toBe(false);
  });

  it("never deletes mid-activity, in either branch", () => {
    expect(shouldAutoDeleteSession({ ...base, busy: true })).toBe(false);
    expect(shouldAutoDeleteSession({ ...base, queuedCount: 2 })).toBe(false);
    expect(shouldAutoDeleteSession({ ...base, temporary: true, messageCount: 3, busy: true })).toBe(
      false,
    );
    expect(
      shouldAutoDeleteSession({ ...base, temporary: true, messageCount: 3, queuedCount: 1 }),
    ).toBe(false);
  });

  it("gives the first second of a visit a grace period", () => {
    expect(shouldAutoDeleteSession({ ...base, mountedForMs: AUTO_DELETE_MIN_MOUNT_MS - 1 })).toBe(
      false,
    );
    expect(shouldAutoDeleteSession({ ...base, mountedForMs: AUTO_DELETE_MIN_MOUNT_MS })).toBe(true);
    expect(
      shouldAutoDeleteSession({ ...base, temporary: true, messageCount: 5, mountedForMs: 500 }),
    ).toBe(false);
  });
});
