import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The recovery pass: a restart kills every chat run in flight, and the chats a
 * restart killed are the only ones it may pick up again.
 *
 * The record is what says a run is unsettled, and its heartbeat is what says
 * whether anyone is still working on it. A run that finished, failed or was
 * stopped deleted its own record; a run another process is refreshing is left
 * alone; a run whose message already has its answer left a record behind that is
 * dropped rather than resumed.
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

const mockHasFinalAnswer = vi.fn();
vi.mock("@/lib/chat/run-answer", () => ({
  hasFinalAnswer: (...args: unknown[]) => mockHasFinalAnswer(...args),
}));

const mockResolveChatModel = vi.fn();
vi.mock("@/lib/pi/chat-session-factory", () => ({
  resolveChatModel: (...args: unknown[]) => mockResolveChatModel(...args),
}));

const mockListRuns = vi.fn();
const mockClaimRun = vi.fn();
const mockDropRun = vi.fn();
const mockEndRun = vi.fn();
vi.mock("@/lib/chat/run-record", () => ({
  listInterruptedChatRuns: (...args: unknown[]) => mockListRuns(...args),
  claimInterruptedChatRun: (...args: unknown[]) => mockClaimRun(...args),
  dropInterruptedChatRun: (...args: unknown[]) => mockDropRun(...args),
  endChatRun: (...args: unknown[]) => mockEndRun(...args),
  RUN_HEARTBEAT_STALE_MS: 20_000,
  isRunHeartbeatStale: (run: { heartbeatAt: Date }, now = Date.now()) =>
    now - run.heartbeatAt.getTime() > 20_000,
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

/** A run whose owner stopped refreshing it a while ago. */
const RUN = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  messageId: MESSAGE_ID,
  startedAt: new Date("2026-11-13T09:00:00Z"),
  heartbeatAt: new Date("2026-11-13T09:05:00Z"),
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
    mockHasFinalAnswer.mockResolvedValue(false);
    mockClaimRun.mockResolvedValue(true);
    mockDropRun.mockResolvedValue(undefined);
    mockEndRun.mockResolvedValue(undefined);
    mockFindSession.mockResolvedValue(CHAT);
    mockFindMessage
      .mockResolvedValueOnce({ role: "user", ...TARGET })
      .mockResolvedValueOnce({ id: MESSAGE_ID });
    mockResolveChatModel.mockResolvedValue({ provider: "anthropic", name: "claude-sonnet-4-5" });
    mockPrepare.mockResolvedValue({ entry: {}, target: TARGET, mode: "continue", images: [] });
    mockDispatch.mockResolvedValue(true);
  });

  it("picks the interrupted message back up", async () => {
    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        model: { provider: "anthropic", name: "claude-sonnet-4-5" },
        target: TARGET,
        // The transcript still holds the turn: continue it, do not resend.
        resume: true,
      }),
    );
    expect(mockDispatch).toHaveBeenCalled();
    // Whatever the user queued behind the interrupted run goes out next.
    expect(mockDrain).toHaveBeenCalled();
    expect(report.resumed).toEqual([SESSION_ID]);
  });

  it("leaves a run another process is still refreshing alone", async () => {
    mockListRuns.mockResolvedValue([{ ...RUN, heartbeatAt: new Date() }]);

    const report = await resumeInterruptedChatRuns();

    expect(mockClaimRun).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(report.live).toEqual([SESSION_ID]);
  });

  it("leaves a run that is still live in another process alone", async () => {
    mockIsSessionActive.mockResolvedValue(true);

    const report = await resumeInterruptedChatRuns();

    expect(mockClaimRun).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(report.live).toEqual([SESSION_ID]);
  });

  it("does not resume a chat the user stopped by hand", async () => {
    mockIsSendQueueHeld.mockResolvedValue(true);

    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockDropRun).toHaveBeenCalledWith(RUN);
    expect(report.dropped).toEqual([SESSION_ID]);
  });

  it("drops the record of a run that did answer", async () => {
    mockHasFinalAnswer.mockResolvedValue(true);

    const report = await resumeInterruptedChatRuns();

    expect(mockHasFinalAnswer).toHaveBeenCalledWith(SESSION_ID, RUN.startedAt);
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockDropRun).toHaveBeenCalledWith(RUN);
    expect(report.dropped).toEqual([SESSION_ID]);
  });

  it("does not resume a message a later one overtook", async () => {
    mockFindMessage
      .mockReset()
      .mockResolvedValueOnce({ role: "user", ...TARGET })
      .mockResolvedValueOnce({ id: "message-2" });

    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockDropRun).toHaveBeenCalledWith(RUN);
    expect(report.dropped).toEqual([SESSION_ID]);
  });

  it("stands down when another process claimed the run first", async () => {
    mockClaimRun.mockResolvedValue(false);

    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(report.live).toEqual([SESSION_ID]);
    expect(report.resumed).toEqual([]);
  });

  it("does not prompt a run the agent pool has already claimed", async () => {
    mockPrepare.mockResolvedValue(null);

    const report = await resumeInterruptedChatRuns();

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(report.live).toEqual([SESSION_ID]);
  });

  it("drops the record of a chat that no longer exists", async () => {
    mockFindSession.mockResolvedValue(null);

    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(report.dropped).toEqual([SESSION_ID]);
  });

  it("drops a run whose target message is no longer a user message", async () => {
    mockFindMessage.mockReset().mockResolvedValueOnce({ role: "assistant", ...TARGET });

    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockDropRun).toHaveBeenCalledWith(RUN);
    expect(report.dropped).toEqual([SESSION_ID]);
  });

  it("keeps the record when the chat has no model to answer with", async () => {
    mockResolveChatModel.mockResolvedValue(null);

    const report = await resumeInterruptedChatRuns();

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockEndRun).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(report.dropped).toEqual([SESSION_ID]);
  });

  it("keeps sweeping after the pass failed for one chat", async () => {
    mockListRuns.mockResolvedValue([{ ...RUN, sessionId: "chat-2" }, RUN]);
    mockFindSession.mockImplementation(async (arg: { where: { id: string } }) => ({
      ...CHAT,
      id: arg.where.id,
    }));
    mockIsSessionActive.mockImplementation(async (_userId: unknown, sessionId: string) =>
      sessionId === "chat-2" ? Promise.reject(new Error("redis down")) : false,
    );

    const report = await resumeInterruptedChatRuns();

    expect(report.resumed).toEqual([SESSION_ID]);
  });

  it("does nothing at all when no run was left in flight", async () => {
    mockListRuns.mockResolvedValue([]);

    const report = await resumeInterruptedChatRuns();

    expect(report).toEqual({ resumed: [], dropped: [], live: [] });
    expect(mockIsSessionActive).not.toHaveBeenCalled();
  });
});
