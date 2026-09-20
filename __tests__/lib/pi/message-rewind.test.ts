import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AgentSession,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  applyPendingHistoryRewind,
  findRewindEntry,
  rewindSessionToMessage,
  transcriptUserMessages,
} from "@/lib/pi/message-rewind";

const { mockGetPendingHistoryRewind, mockClaimPendingHistoryRewind } = vi.hoisted(() => ({
  mockGetPendingHistoryRewind: vi.fn(),
  mockClaimPendingHistoryRewind: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/redis", () => ({
  getPendingHistoryRewind: mockGetPendingHistoryRewind,
  claimPendingHistoryRewind: mockClaimPendingHistoryRewind,
}));

/**
 * Editing a message rewrites the DB history, but the Pi transcript is
 * append-only. Without a rewind the edited prompt is appended after the
 * messages the edit deleted, so the model reads it as a brand new message
 * following the old conversation. These tests pin the rewind: which transcript
 * entry it targets, and what it does when the entry is ambiguous or missing.
 */

function userEntry(id: string, text: string, parentId: string | null): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  } as unknown as SessionMessageEntry;
}

function assistantEntry(id: string, parentId: string, text = "answer"): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 },
  } as unknown as SessionMessageEntry;
}

/** Two exchanges: ALPHA → answer, BETA → answer. */
function twoTurnBranch(): SessionEntry[] {
  return [
    userEntry("u1", "ALPHA", null),
    assistantEntry("a1", "u1"),
    userEntry("u2", "BETA", "a1"),
    assistantEntry("a2", "u2"),
  ];
}

function fakeSession(branch: SessionEntry[], leafId: string | null) {
  const navigateTree = vi.fn().mockResolvedValue({ cancelled: false });
  const sessionManager = {
    getBranch: () => branch,
    getLeafId: () => leafId,
    resetLeaf: vi.fn(),
    buildSessionContext: () => ({ messages: [{ role: "user", content: "ALPHA" }] }),
  };
  const session = {
    sessionManager,
    navigateTree,
    agent: { state: { messages: [] as unknown[] } },
  };
  return { session: session as unknown as AgentSession, navigateTree, sessionManager };
}

describe("transcriptUserMessages", () => {
  it("returns only the user messages, in branch order", () => {
    const { session } = fakeSession(twoTurnBranch(), "a2");

    expect(transcriptUserMessages(session).map((e) => e.id)).toEqual(["u1", "u2"]);
  });
});

describe("findRewindEntry", () => {
  it("uses the DB position when the content still matches", () => {
    const entries = transcriptUserMessages(fakeSession(twoTurnBranch(), "a2").session);

    const found = findRewindEntry(entries, { userMessageIndex: 1, previousContent: "BETA" });

    expect(found?.id).toBe("u2");
  });

  it("falls back to the content match when the transcript has drifted", () => {
    // A prompt that failed before the SDK recorded it shifts every later
    // position — the content is the only reliable signal left.
    const entries = transcriptUserMessages(fakeSession(twoTurnBranch(), "a2").session);

    const found = findRewindEntry(entries, { userMessageIndex: 5, previousContent: "ALPHA" });

    expect(found?.id).toBe("u1");
  });

  it("picks the occurrence nearest the DB position when the text repeats", () => {
    const branch = [
      userEntry("u1", "hi", null),
      assistantEntry("a1", "u1"),
      userEntry("u2", "hi", "a1"),
      assistantEntry("a2", "u2"),
    ];
    const entries = transcriptUserMessages(fakeSession(branch, "a2").session);

    expect(findRewindEntry(entries, { userMessageIndex: 0, previousContent: "hi" })?.id).toBe("u1");
    expect(findRewindEntry(entries, { userMessageIndex: 1, previousContent: "hi" })?.id).toBe("u2");
  });

  it("returns null rather than guessing when nothing matches", () => {
    const entries = transcriptUserMessages(fakeSession(twoTurnBranch(), "a2").session);

    expect(
      findRewindEntry(entries, { userMessageIndex: 0, previousContent: "DIFFERENT" }),
    ).toBeNull();
  });
});

describe("rewindSessionToMessage", () => {
  it("navigates to the edited message's own entry", async () => {
    const { session, navigateTree } = fakeSession(twoTurnBranch(), "a2");

    const rewound = await rewindSessionToMessage(session, {
      userMessageIndex: 1,
      previousContent: "BETA",
    });

    expect(rewound).toBe(true);
    expect(navigateTree).toHaveBeenCalledWith("u2");
  });

  it("navigates to the parent when the message is still the leaf", async () => {
    // The reply never landed, so the message itself is the end of the branch
    // and navigating to it would be a no-op.
    const branch = [userEntry("u1", "ALPHA", null), userEntry("u2", "BETA", "u1")];
    const { session, navigateTree } = fakeSession(branch, "u2");

    const rewound = await rewindSessionToMessage(session, {
      userMessageIndex: 1,
      previousContent: "BETA",
    });

    expect(rewound).toBe(true);
    expect(navigateTree).toHaveBeenCalledWith("u1");
  });

  it("resets the leaf when the first message is the leaf", async () => {
    const branch = [userEntry("u1", "ALPHA", null)];
    const { session, navigateTree, sessionManager } = fakeSession(branch, "u1");

    const rewound = await rewindSessionToMessage(session, {
      userMessageIndex: 0,
      previousContent: "ALPHA",
    });

    expect(rewound).toBe(true);
    expect(navigateTree).not.toHaveBeenCalled();
    expect(sessionManager.resetLeaf).toHaveBeenCalled();
    expect(session.agent.state.messages).toEqual([{ role: "user", content: "ALPHA" }]);
  });

  it("leaves the session alone when the edited message is not in the transcript", async () => {
    const { session, navigateTree } = fakeSession(twoTurnBranch(), "a2");

    const rewound = await rewindSessionToMessage(session, {
      userMessageIndex: 3,
      previousContent: "NEVER PROMPTED",
    });

    expect(rewound).toBe(false);
    expect(navigateTree).not.toHaveBeenCalled();
  });

  it("matches messages whose content is plain text rather than blocks", async () => {
    const branch = [
      userEntry("u1", "ALPHA", null),
      { ...userEntry("u2", "ignored", "u1"), message: { role: "user", content: "BETA" } },
    ] as SessionEntry[];
    const { session, navigateTree } = fakeSession(branch, "u1");

    const rewound = await rewindSessionToMessage(session, {
      userMessageIndex: 1,
      previousContent: "BETA",
    });

    expect(rewound).toBe(true);
    expect(navigateTree).toHaveBeenCalledWith("u2");
  });
});

describe("applyPendingHistoryRewind", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimPendingHistoryRewind.mockResolvedValue(null);
  });

  it("rewinds and claims when the request is for this message", async () => {
    mockGetPendingHistoryRewind.mockResolvedValue({
      messageId: "msg-2",
      previousContent: "BETA",
      userMessageIndex: 1,
    });
    const { session, navigateTree } = fakeSession(twoTurnBranch(), "a2");

    const outcome = await applyPendingHistoryRewind("session-1", session, "msg-2");

    expect(outcome).toBe("rewound");
    expect(navigateTree).toHaveBeenCalledWith("u2");
    expect(mockClaimPendingHistoryRewind).toHaveBeenCalledWith("session-1");
  });

  it("leaves the request alone when another message is being prompted", async () => {
    mockGetPendingHistoryRewind.mockResolvedValue({
      messageId: "msg-2",
      previousContent: "BETA",
      userMessageIndex: 1,
    });
    const { session, navigateTree } = fakeSession(twoTurnBranch(), "a2");

    const outcome = await applyPendingHistoryRewind("session-1", session, "msg-9");

    // Still pending for msg-2 — claiming it here would throw the edit away.
    expect(outcome).toBe("nothing-pending");
    expect(mockClaimPendingHistoryRewind).not.toHaveBeenCalled();
    expect(navigateTree).not.toHaveBeenCalled();
  });

  it("reports a transcript the rewind could not locate", async () => {
    mockGetPendingHistoryRewind.mockResolvedValue({
      messageId: "msg-2",
      previousContent: "NEVER PROMPTED",
      userMessageIndex: 1,
    });
    const { session, navigateTree } = fakeSession(twoTurnBranch(), "a2");

    const outcome = await applyPendingHistoryRewind("session-1", session, "msg-2");

    expect(outcome).toBe("no-transcript-entry");
    expect(navigateTree).not.toHaveBeenCalled();
  });

  it("logs a failed rewind instead of failing the prompt", async () => {
    mockGetPendingHistoryRewind.mockResolvedValue({
      messageId: "msg-2",
      previousContent: "BETA",
      userMessageIndex: 1,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { session } = fakeSession(twoTurnBranch(), "a2");
    vi.spyOn(session, "navigateTree").mockRejectedValue(new Error("entry not found"));

    const outcome = await applyPendingHistoryRewind("session-1", session, "msg-2");

    expect(outcome).toBe("no-transcript-entry");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to rewind the transcript for edited message msg-2"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
