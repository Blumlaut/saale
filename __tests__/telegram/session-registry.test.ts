import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  isTelegramSessionActive,
  isLatestMessage,
  beginTelegramRun,
  attachTelegramSession,
  clearTelegramRun,
  unregisterTelegramSession,
  wasTelegramSessionInterrupted,
  interruptTelegramChat,
  nextMessageSeq,
  shutdownTelegramSessions,
} from "@/lib/telegram/session-registry";

function makeSession() {
  return { abort: vi.fn().mockResolvedValue(undefined) } as unknown as AgentSession;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Each test gets a unique chatId so module-level registry state never leaks across tests. */
let chatCounter = 0;
function nextChatId(): bigint {
  return BigInt(++chatCounter);
}

const USER = "user-1";

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("telegram session registry", () => {
  describe("message sequence (latest message wins)", () => {
    it("nextMessageSeq increments per chat and is isolated between chats and users", () => {
      const chatA = nextChatId();
      const chatB = nextChatId();

      expect(nextMessageSeq(USER, chatA)).toBe(1);
      expect(nextMessageSeq(USER, chatA)).toBe(2);
      // Different chat (and different user) start at their own sequence.
      expect(nextMessageSeq(USER, chatB)).toBe(1);
      expect(nextMessageSeq("other-user", chatA)).toBe(1);
    });

    it("isLatestMessage is true only for the most recently bumped sequence", () => {
      const chatId = nextChatId();

      const first = nextMessageSeq(USER, chatId);
      // Right after the bump it is still the latest message.
      expect(isLatestMessage(USER, chatId, first)).toBe(true);

      const second = nextMessageSeq(USER, chatId);
      // A newer message supersedes the older one.
      expect(isLatestMessage(USER, chatId, first)).toBe(false);
      expect(isLatestMessage(USER, chatId, second)).toBe(true);
    });
  });

  describe("two-stage registration", () => {
    it("a run is active from beginTelegramRun, before the Pi session exists", () => {
      const chatId = nextChatId();

      expect(isTelegramSessionActive(USER, chatId)).toBe(false);

      beginTelegramRun(USER, chatId, Promise.resolve());
      // Active even while session is still null (slow pre-session setup).
      expect(isTelegramSessionActive(USER, chatId)).toBe(true);

      const session = makeSession();
      attachTelegramSession(USER, chatId, session);

      unregisterTelegramSession(USER, chatId, session);
      expect(isTelegramSessionActive(USER, chatId)).toBe(false);
    });

    it("attachTelegramSession is a no-op when the entry was already replaced", () => {
      const chatId = nextChatId();

      const oldSession = makeSession();
      beginTelegramRun(USER, chatId, Promise.resolve());
      attachTelegramSession(USER, chatId, oldSession);

      // A new run overwrites the entry (as it does when it starts).
      beginTelegramRun(USER, chatId, Promise.resolve());

      // Must not throw and must not resurrect the old session.
      const newSession = makeSession();
      attachTelegramSession(USER, chatId, newSession);
      expect(wasTelegramSessionInterrupted(oldSession)).toBe(false);
      expect(isTelegramSessionActive(USER, chatId)).toBe(true);
    });
  });

  it("unregister is identity-checked: a late cleanup of an old run keeps the new run registered", () => {
    // Regression: when a run is interrupted, the new run registers under
    // the same chat key before the old run's finally executes. The old
    // run's unregister must not delete the NEW run's entry.
    const chatId = nextChatId();
    const oldSession = makeSession();
    const newSession = makeSession();

    beginTelegramRun(USER, chatId, Promise.resolve());
    attachTelegramSession(USER, chatId, oldSession);
    // New run overwrites the entry...
    beginTelegramRun(USER, chatId, Promise.resolve());
    attachTelegramSession(USER, chatId, newSession);

    // ...then the old run's late cleanup runs:
    unregisterTelegramSession(USER, chatId, oldSession);

    // The new run's entry must survive.
    expect(isTelegramSessionActive(USER, chatId)).toBe(true);

    // And only the new session unregisters it.
    unregisterTelegramSession(USER, chatId, newSession);
    expect(isTelegramSessionActive(USER, chatId)).toBe(false);
  });

  it("unregister for a different user's session is a no-op", () => {
    const chatId = nextChatId();
    const session = makeSession();
    beginTelegramRun(USER, chatId, Promise.resolve());
    attachTelegramSession(USER, chatId, session);

    // Another user, same chatId (different key) — nothing to delete.
    unregisterTelegramSession("other-user", chatId, session);
    expect(isTelegramSessionActive(USER, chatId)).toBe(true);
  });

  describe("interruptTelegramChat", () => {
    it("marks the run interrupted, aborts the live session, and resolves when the run settles", async () => {
      const chatId = nextChatId();
      const session = makeSession();
      const done = deferred();

      beginTelegramRun(USER, chatId, done.promise);
      attachTelegramSession(USER, chatId, session);

      const interrupting = interruptTelegramChat(USER, chatId);
      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(wasTelegramSessionInterrupted(session)).toBe(true);

      // Still pending until the run actually settles:
      let resolved = false;
      void interrupting.then(() => {
        resolved = true;
      });
      expect(resolved).toBe(false);

      done.resolve();
      await interrupting;
      expect(resolved).toBe(true);
    });

    it("waits for a pre-session run (session null) without aborting", async () => {
      // A run in slow setup cannot be aborted; the interrupt marks it and
      // waits for the run to notice its supersession and settle on its own.
      const chatId = nextChatId();
      const done = deferred();

      beginTelegramRun(USER, chatId, done.promise);

      const interrupting = interruptTelegramChat(USER, chatId);
      await flush();
      let resolved = false;
      void interrupting.then(() => {
        resolved = true;
      });
      expect(resolved).toBe(false);

      // The run bails at its checkpoint and settles:
      done.resolve();
      await interrupting;
      expect(resolved).toBe(true);
    });

    it("resolves immediately when no run is active", async () => {
      await expect(interruptTelegramChat(USER, nextChatId())).resolves.toBeUndefined();
    });

    it("a second interrupt during the settling window is harmless", async () => {
      const chatId = nextChatId();
      const session = makeSession();
      const done = deferred();

      beginTelegramRun(USER, chatId, done.promise);
      attachTelegramSession(USER, chatId, session);

      const first = interruptTelegramChat(USER, chatId);
      const second = interruptTelegramChat(USER, chatId);
      // Both await the same settling promise; each interrupt re-aborts
      // (abort is idempotent, so this is harmless).
      expect(session.abort).toHaveBeenCalledTimes(2);

      done.resolve();
      await Promise.all([first, second]);
      expect(session.abort).toHaveBeenCalledTimes(2);
    });

    it("a new run registered after an interrupt is not marked interrupted", () => {
      // Interrupt flow end-to-end: interrupt old run, new run takes over the slot.
      const chatId = nextChatId();
      const oldSession = makeSession();
      const newSession = makeSession();

      beginTelegramRun(USER, chatId, Promise.resolve());
      attachTelegramSession(USER, chatId, oldSession);
      void interruptTelegramChat(USER, chatId);
      expect(wasTelegramSessionInterrupted(oldSession)).toBe(true);

      // Old run's finally runs (identity-checked — no-op now)...
      unregisterTelegramSession(USER, chatId, oldSession);

      // New run registers and must NOT inherit the interrupted flag.
      beginTelegramRun(USER, chatId, Promise.resolve());
      attachTelegramSession(USER, chatId, newSession);
      expect(wasTelegramSessionInterrupted(newSession)).toBe(false);
      expect(isTelegramSessionActive(USER, chatId)).toBe(true);
    });
  });

  it("wasTelegramSessionInterrupted is false for unknown or unregistered sessions", () => {
    expect(wasTelegramSessionInterrupted(makeSession())).toBe(false);
  });

  it("clearTelegramRun removes the entry outright (supersession bails)", () => {
    const chatId = nextChatId();
    const session = makeSession();

    beginTelegramRun(USER, chatId, Promise.resolve());
    attachTelegramSession(USER, chatId, session);
    expect(isTelegramSessionActive(USER, chatId)).toBe(true);

    clearTelegramRun(USER, chatId);
    expect(isTelegramSessionActive(USER, chatId)).toBe(false);

    // Clearing an unknown chat is a no-op.
    clearTelegramRun(USER, nextChatId());
  });

  it("shutdownTelegramSessions aborts live sessions and clears the registry", async () => {
    const chatA = nextChatId();
    const chatB = nextChatId();
    const sessionA = makeSession();
    const sessionB = makeSession();

    beginTelegramRun(USER, chatA, Promise.resolve());
    attachTelegramSession(USER, chatA, sessionA);
    beginTelegramRun(USER, chatB, Promise.resolve());
    // Pre-session run — nothing to abort.

    shutdownTelegramSessions();

    await flush();
    expect(sessionA.abort).toHaveBeenCalledTimes(1);
    expect(sessionB.abort).not.toHaveBeenCalled();
    expect(isTelegramSessionActive(USER, chatA)).toBe(false);
    expect(isTelegramSessionActive(USER, chatB)).toBe(false);
  });
});
