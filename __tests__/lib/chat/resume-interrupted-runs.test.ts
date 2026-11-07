import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The boot pass: a restart kills every chat run in flight, and the chats a
 * restart killed are the only ones it may pick up again. A run that finished,
 * failed or was stopped cleared its own record and is not touched; a run that is
 * still live in another process (the worker's Telegram replies) is left alone.
 */

const mockFindSession = vi.fn();
const mockFindMessage = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: { findFirst: (...args: unknown[]) => mockFindSession(...args) },
    chatMessage: { findFirst: (...args: unknown[]) => mockFindMessage(...args) },
  },
}));

const mockIsSessionActive = vi.fn();
const mockIsSendQueueHeld = vi.fn();
vi.mock("@/lib/redis", () => ({
  isSessionActive: (...args: unknown[]) => mockIsSessionActive(...args),
  isSendQueueHeld: (...args: unknown[]) => mockIsSendQueueHeld(...args),
}));

const mockResolveChatModel = vi.fn();
vi.mock("@/lib/pi/chat-session-factory", () => ({
  resolveChatModel: (...args: unknown[]) => mockResolveChatModel(...args),
}));

const mockListRuns = vi.fn();
const mockClaimRun = vi.fn();
vi.mock("@/lib/chat/run-record", () => ({
  listInterruptedChatRuns: (...args: unknown[]) => mockListRuns(...args),
  claimInterruptedChatRun: (...args: unknown[]) => mockClaimRun(...args),
}));

const mockPrepare = vi.fn();
const mockDispatch = vi.fn();
const mockDrain = vi.fn();
vi.mock("@/lib/chat/run-prompt", () => ({
  prepareChatRun: (...args: unknown[]) => mockPrepare(...args),
  dispatchPreparedChatRun: (...args: unknown[]) => mockDispatch(...args),
  createChatQueueDrain:
    () =>
    (...args: unknown[]) =>
      mockDrain(...args),
}));

import { resumeInterruptedChatRuns } from "@/lib/chat/resume-interrupted-runs";

const USER_ID = "user-1";
const SESSION_ID = "chat-1";
const MESSAGE_ID = "message-1";

const CHAT = {
  id: SESSION_ID,
  origin: "user",
  projectId: null,
  modelProvider: "anthropic",
  modelName: "claude-sonnet-4-5",
  thinkingLevel: "off",
  toolConfig: null,
};

const RUN = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  messageId: MESSAGE_ID,
  startedAt: new Date("2026-11-13T09:00:00Z"),
};

const TARGET = {
  id: MESSAGE_ID,
  content: "what is the status of the build?",
  attachments: [],
};

describe("resumeInterruptedChatRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListRuns.mockResolvedValue([RUN]);
    mockIsSessionActive.mockResolvedValue(false);
    mockIsSendQueueHeld.mockResolvedValue(false);
    mockClaimRun.mockResolvedValue(true);
    mockFindSession.mockResolvedValue(CHAT);
    mockFindMessage.mockResolvedValueOnce({ role: "user", ...TARGET }).mockResolvedValueOnce(null);
    mockResolveChatModel.mockResolvedValue({ provider: "anthropic", name: "claude-sonnet-4-5" });
    mockPrepare.mockResolvedValue({ entry: {}, target: TARGET, images: [] });
    mockDispatch.mockResolvedValue(true);
  });

  it("prompts the message a restart left unanswered", async () => {
    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        model: { provider: "anthropic", name: "claude-sonnet-4-5" },
        target: TARGET,
      }),
    );
    expect(mockDispatch).toHaveBeenCalled();
    // Whatever the user queued behind the interrupted run goes out next.
    expect(mockDrain).toHaveBeenCalled();
    expect(report.resumed).toEqual([SESSION_ID]);
  });

  it("leaves a chat alone while another process is still running it", async () => {
    mockIsSessionActive.mockResolvedValue(true);

    const report = await resumeInterruptedChatRuns();

    expect(mockClaimRun).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(report.live).toEqual([SESSION_ID]);
    expect(report.resumed).toEqual([]);
  });

  it("does not resume a chat the user stopped by hand", async () => {
    mockIsSendQueueHeld.mockResolvedValue(true);

    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(report.dropped).toEqual([SESSION_ID]);
  });

  it("does not answer a message the model already replied to", async () => {
    mockFindMessage
      .mockReset()
      .mockResolvedValueOnce({ role: "user", ...TARGET })
      .mockResolvedValueOnce({ id: "assistant-1" });

    const report = await resumeInterruptedChatRuns();

    expect(mockFindMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sessionId: SESSION_ID,
          role: "assistant",
          createdAt: { gt: RUN.startedAt },
          content: { not: "" },
        }),
      }),
    );
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(report.dropped).toEqual([SESSION_ID]);
  });

  it("resumes a run that only got as far as tool calls", async () => {
    // A turn saved with tool calls and no text is the model's work in progress,
    // so the user has no reply yet and the run picks up where it stopped.
    mockFindMessage
      .mockReset()
      .mockResolvedValueOnce({ role: "user", ...TARGET })
      .mockResolvedValueOnce(null);

    const report = await resumeInterruptedChatRuns();

    expect(mockDispatch).toHaveBeenCalled();
    expect(report.resumed).toEqual([SESSION_ID]);
  });

  it("resumes a message only earlier runs answered", async () => {
    // The reply that ended the run before this one predates the claim, so it
    // does not make this run answered.
    mockFindMessage
      .mockReset()
      .mockResolvedValueOnce({ role: "user", ...TARGET })
      .mockResolvedValueOnce(null);

    const report = await resumeInterruptedChatRuns();

    expect(mockDispatch).toHaveBeenCalled();
    expect(report.resumed).toEqual([SESSION_ID]);
  });

  it("stands down when another process claimed the run first", async () => {
    mockClaimRun.mockResolvedValue(false);

    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(report.resumed).toEqual([]);
  });

  it("does not prompt a run the agent pool has already claimed", async () => {
    mockPrepare.mockResolvedValue(null);

    const report = await resumeInterruptedChatRuns();

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(report.dropped).toEqual([SESSION_ID]);
  });

  it("drops the record of a chat that no longer exists", async () => {
    mockFindSession.mockResolvedValue(null);

    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(report.dropped).toEqual([SESSION_ID]);
  });

  it("does nothing at all when no run was left in flight", async () => {
    mockListRuns.mockResolvedValue([]);

    const report = await resumeInterruptedChatRuns();

    expect(report).toEqual({ resumed: [], dropped: [], live: [] });
    expect(mockIsSessionActive).not.toHaveBeenCalled();
  });
});
