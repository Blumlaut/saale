import { beforeEach, describe, expect, it, vi } from "vitest";

const findSession = vi.fn();
const findMessages = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: { findFirst: (args: unknown) => findSession(args) },
    chatMessage: { findMany: (args: unknown) => findMessages(args) },
  },
}));

import { loadSharedChat } from "@/lib/chat/share";

/**
 * A share token is the capability that opens a chat, and the access level is the
 * second gate on top of it. The gate has to come before the message query, so a
 * visitor who is turned away never has a row loaded on their behalf.
 */

/** A secret a leak would have to carry out through a tool call. */
const CANARY = "9f3a2b7c-quarantine";

const SESSION = {
  id: "s1",
  title: "Shared run",
  createdAt: new Date("2026-01-01T12:00:00.000Z"),
  shareAccess: "public",
};

function storedMessage() {
  return {
    id: "m1",
    role: "assistant",
    content: "Done.",
    thinking: "the owner's reasoning",
    errorMessage: null,
    toolCalls: JSON.stringify([
      {
        id: "t1",
        name: "bash",
        args: { command: `cat /home/blumlaut/${CANARY}.flac` },
        result: `ls: cannot access /home/blumlaut/${CANARY}.flac`,
        isError: false,
      },
    ]),
    parentMessageId: null,
    createdAt: new Date("2026-01-01T12:00:01.000Z"),
  };
}

beforeEach(() => {
  findSession.mockReset();
  findMessages.mockReset();
  findSession.mockResolvedValue(SESSION);
  findMessages.mockResolvedValue([storedMessage()]);
});

describe("who may open a share link", () => {
  it("opens a public chat to a visitor without an account", async () => {
    const shared = await loadSharedChat("tok", null);

    expect(shared.state).toBe("ok");
    expect(shared.state === "ok" && shared.session.title).toBe("Shared run");
    expect(shared.state === "ok" && shared.messages).toHaveLength(1);
  });

  it("asks a visitor to sign in for a chat shared with accounts only", async () => {
    findSession.mockResolvedValue({ ...SESSION, shareAccess: "account" });

    expect(await loadSharedChat("tok", null)).toEqual({ state: "needs-auth" });
    // The point of the ordering: nothing was read for the visitor we refuse.
    expect(findMessages).not.toHaveBeenCalled();
  });

  it("opens a chat shared with accounts only to a signed-in viewer", async () => {
    findSession.mockResolvedValue({ ...SESSION, shareAccess: "account" });

    const shared = await loadSharedChat("tok", "user-1");

    expect(shared.state).toBe("ok");
    expect(shared.state === "ok" && shared.messages).toHaveLength(1);
  });

  it("closes a chat whose stored access it does not recognise (edge case)", async () => {
    findSession.mockResolvedValue({ ...SESSION, shareAccess: "everyone-we-know" });

    expect(await loadSharedChat("tok", null)).toEqual({ state: "needs-auth" });
    expect(findMessages).not.toHaveBeenCalled();
  });

  it("reports an unknown token as not found", async () => {
    findSession.mockResolvedValue(null);

    expect(await loadSharedChat("nope", null)).toEqual({ state: "not-found" });
    expect(findMessages).not.toHaveBeenCalled();
  });

  it("only looks up a session that is still shared", async () => {
    await loadSharedChat("tok", null);

    expect(findSession).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shareToken: "tok", shared: true } }),
    );
  });
});

describe("what a share link hands back", () => {
  it("redacts tool calls, thinking and the owner's timestamps", async () => {
    const shared = await loadSharedChat("tok", null);
    if (shared.state !== "ok") throw new Error("expected an opened chat");

    const [message] = shared.messages;
    const serialized = JSON.stringify(message);

    expect(serialized).toContain("Ran a shell command");
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("/home/blumlaut");
    expect(message?.thinking).toBeUndefined();
    expect(message?.attachments).toBeUndefined();
  });

  it("leaves queued messages out of the transcript", async () => {
    await loadSharedChat("tok", null);

    expect(findMessages).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: "s1", queuedAt: null } }),
    );
  });
});
