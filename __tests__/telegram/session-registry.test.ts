import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  isTelegramSessionActive,
  registerTelegramSession,
  unregisterTelegramSession,
  wasTelegramSessionInterrupted,
  abortTelegramSession,
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

describe("telegram session registry", () => {
  it("tracks active sessions and removes them on unregister", () => {
    const chatId = nextChatId();
    const session = makeSession();

    expect(isTelegramSessionActive(USER, chatId)).toBe(false);

    registerTelegramSession(USER, chatId, session, Promise.resolve());
    expect(isTelegramSessionActive(USER, chatId)).toBe(true);

    unregisterTelegramSession(USER, chatId, session);
    expect(isTelegramSessionActive(USER, chatId)).toBe(false);
  });

  it("unregister is identity-checked: a late cleanup of an old run keeps the new run registered", () => {
    // Regression: when a run is interrupted, the new run registers under
    // the same chat key before the old run's finally executes. The old
    // run's unregister must not delete the NEW run's entry.
    const chatId = nextChatId();
    const oldSession = makeSession();
    const newSession = makeSession();

    registerTelegramSession(USER, chatId, oldSession, Promise.resolve());
    // New run overwrites the entry...
    registerTelegramSession(USER, chatId, newSession, Promise.resolve());

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
    registerTelegramSession(USER, chatId, session, Promise.resolve());

    // Another user, same chatId (different key) — nothing to delete.
    unregisterTelegramSession("other-user", chatId, session);
    expect(isTelegramSessionActive(USER, chatId)).toBe(true);
  });

  it("abortTelegramSession marks the run interrupted and resolves when the run settles", async () => {
    const chatId = nextChatId();
    const session = makeSession();
    const done = deferred();

    registerTelegramSession(USER, chatId, session, done.promise);

    const aborting = abortTelegramSession(USER, chatId);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(wasTelegramSessionInterrupted(session)).toBe(true);

    // Still pending until the run actually settles:
    let resolved = false;
    void aborting.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);

    done.resolve();
    await aborting;
    expect(resolved).toBe(true);
  });

  it("abortTelegramSession resolves immediately when no session is active", async () => {
    await expect(abortTelegramSession(USER, nextChatId())).resolves.toBeUndefined();
  });

  it("abort on a settled run is a no-op that still resolves", async () => {
    const chatId = nextChatId();
    const session = makeSession();
    registerTelegramSession(USER, chatId, session, Promise.resolve());

    await abortTelegramSession(USER, chatId);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(wasTelegramSessionInterrupted(session)).toBe(true);
  });

  it("a new run registered after an interrupt is not marked interrupted", () => {
    // Interrupt flow end-to-end: abort old run, new run takes over the slot.
    const chatId = nextChatId();
    const oldSession = makeSession();
    const newSession = makeSession();

    registerTelegramSession(USER, chatId, oldSession, Promise.resolve());
    abortTelegramSession(USER, chatId);
    expect(wasTelegramSessionInterrupted(oldSession)).toBe(true);

    // Old run's finally runs (identity-checked — no-op now)...
    unregisterTelegramSession(USER, chatId, oldSession);

    // New run registers and must NOT inherit the interrupted flag.
    registerTelegramSession(USER, chatId, newSession, Promise.resolve());
    expect(wasTelegramSessionInterrupted(newSession)).toBe(false);
    expect(isTelegramSessionActive(USER, chatId)).toBe(true);
  });

  it("wasTelegramSessionInterrupted is false for unknown or unregistered sessions", () => {
    expect(wasTelegramSessionInterrupted(makeSession())).toBe(false);
  });
});
