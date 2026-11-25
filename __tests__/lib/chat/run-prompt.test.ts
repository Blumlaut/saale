import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The one path that prompts a chat: it has to claim the pooled agent before it
 * starts work, and give the claim back when the work never reaches the agent.
 */

const mockEnsureAgent = vi.fn();
const mockBeginRun = vi.fn();
vi.mock("@/lib/chat/agent-run", () => ({
  ensureChatAgent: (...args: unknown[]) => mockEnsureAgent(...args),
  beginChatRun: (...args: unknown[]) => mockBeginRun(...args),
}));

const mockRewindDuplicate = vi.fn();
const mockApplyPendingRewind = vi.fn();
vi.mock("@/lib/pi/message-rewind", () => ({
  rewindDuplicatePrompt: (...args: unknown[]) => mockRewindDuplicate(...args),
  applyPendingHistoryRewind: (...args: unknown[]) => mockApplyPendingRewind(...args),
}));

const mockPlanTurn = vi.fn();
const mockApplyTurn = vi.fn();
const mockOrphans = vi.fn();
const mockAnswerOrphans = vi.fn();
vi.mock("@/lib/pi/interrupted-turn", () => ({
  planInterruptedTurn: (...args: unknown[]) => mockPlanTurn(...args),
  applyInterruptedTurn: (...args: unknown[]) => mockApplyTurn(...args),
  orphanedCallsOnBranch: (...args: unknown[]) => mockOrphans(...args),
  answerOrphanedCalls: (...args: unknown[]) => mockAnswerOrphans(...args),
}));

const mockReadImage = vi.fn();
vi.mock("@/lib/image-attachment", () => ({
  readImageAsBase64: (...args: unknown[]) => mockReadImage(...args),
}));

vi.mock("@/lib/usage/record", () => ({ chatUsageKind: () => "chat" }));

import { prepareChatRun } from "@/lib/chat/run-prompt";

const CHAT = {
  id: "chat-1",
  origin: "user",
  projectId: null,
  modelProvider: "anthropic",
  modelName: "claude-sonnet-4-5",
  thinkingLevel: "off",
  toolConfig: null,
};

const TARGET = { id: "message-1", content: "what broke?", attachments: [] };

/** A pooled agent, as the pool hands one out. */
function entry() {
  return { promptInFlight: false, lastPromptedMessageId: null as string | null, session: {} };
}

describe("prepareChatRun", () => {
  let pooled: ReturnType<typeof entry>;

  beforeEach(() => {
    vi.clearAllMocks();
    pooled = entry();
    mockEnsureAgent.mockResolvedValue({ entry: pooled, existedAlready: true });
    mockRewindDuplicate.mockResolvedValue(false);
    mockApplyPendingRewind.mockResolvedValue("nothing-pending");
    mockPlanTurn.mockReturnValue({ kind: "prompt" });
    mockApplyTurn.mockResolvedValue(false);
    mockOrphans.mockReturnValue([]);
    mockBeginRun.mockResolvedValue(undefined);
  });

  it("claims the chat and records the run against its message", async () => {
    const prepared = await prepareChatRun({ userId: "user-1", chatSession: CHAT, target: TARGET });

    expect(prepared?.target).toEqual(TARGET);
    expect(pooled.promptInFlight).toBe(true);
    expect(mockBeginRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: CHAT.id, messageId: TARGET.id }),
    );
  });

  it("hands the chat back when claiming it fails", async () => {
    mockBeginRun.mockRejectedValue(new Error("db down"));

    await expect(
      prepareChatRun({ userId: "user-1", chatSession: CHAT, target: TARGET }),
    ).rejects.toThrow("db down");

    expect(pooled.promptInFlight).toBe(false);
    expect(pooled.lastPromptedMessageId).toBeNull();
  });

  it("refuses a chat another run in this process already claimed", async () => {
    pooled.promptInFlight = true;

    const prepared = await prepareChatRun({ userId: "user-1", chatSession: CHAT, target: TARGET });

    expect(prepared).toBeNull();
    expect(mockBeginRun).not.toHaveBeenCalled();
  });

  it("loads the images of a message it is about to prompt", async () => {
    mockReadImage.mockResolvedValue({ data: "base64", mimeType: "image/webp" });

    const prepared = await prepareChatRun({
      userId: "user-1",
      chatSession: CHAT,
      target: {
        ...TARGET,
        attachments: [
          { storagePath: "shots/a.webp", mimeType: "image/webp" },
          { storagePath: "notes.txt", mimeType: "text/plain" },
        ],
      },
    });

    expect(mockReadImage).toHaveBeenCalledWith("user-1", "shots/a.webp");
    expect(prepared?.images).toEqual([{ type: "image", data: "base64", mimeType: "image/webp" }]);
  });

  it("sends the message when the run is not a resume", async () => {
    const prepared = await prepareChatRun({ userId: "user-1", chatSession: CHAT, target: TARGET });

    expect(prepared?.mode).toBe("prompt");
    expect(mockPlanTurn).not.toHaveBeenCalled();
    expect(mockRewindDuplicate).toHaveBeenCalled();
  });

  it("continues the interrupted turn the transcript still holds", async () => {
    mockPlanTurn.mockReturnValue({ kind: "continue", orphanedCalls: [{ id: "c1", name: "bash" }] });
    mockApplyTurn.mockResolvedValue(true);

    const prepared = await prepareChatRun({
      userId: "user-1",
      chatSession: CHAT,
      target: TARGET,
      resume: true,
    });

    expect(prepared?.mode).toBe("continue");
    expect(mockPlanTurn).toHaveBeenCalledWith(expect.anything(), { content: TARGET.content });
    expect(mockApplyTurn).toHaveBeenCalledWith(expect.anything(), {
      kind: "continue",
      orphanedCalls: [{ id: "c1", name: "bash" }],
    });
    // The message is already in the transcript, so it is not sent again.
    expect(mockRewindDuplicate).not.toHaveBeenCalled();
    // And its images went with it the first time.
    expect(mockReadImage).not.toHaveBeenCalled();
  });

  it("answers a call a dead run left open before sending a new message", async () => {
    // Otherwise the message answers a tool call, which every provider rejects.
    mockOrphans.mockReturnValue([{ id: "c1", name: "bash" }]);

    await prepareChatRun({ userId: "user-1", chatSession: CHAT, target: TARGET });

    expect(mockAnswerOrphans).toHaveBeenCalledWith(expect.anything(), [{ id: "c1", name: "bash" }]);
  });

  it("falls back to sending the message when there is no turn to continue", async () => {
    mockPlanTurn.mockReturnValue({ kind: "prompt" });
    mockApplyTurn.mockResolvedValue(false);
    mockOrphans.mockReturnValue([]);

    const prepared = await prepareChatRun({
      userId: "user-1",
      chatSession: CHAT,
      target: TARGET,
      resume: true,
    });

    expect(prepared?.mode).toBe("prompt");
    expect(mockRewindDuplicate).toHaveBeenCalled();
  });
});
