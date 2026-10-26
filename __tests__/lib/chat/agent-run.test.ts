import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The shared "one chat run" orchestration. The stream route and the
 * `chat_respond` tool both go through it, so the pieces that must not be
 * skipped  the approval gate on session creation, registering the generation,
 * wiring persistence  are pinned here.
 */

const mockGetPoolEntry = vi.fn();
const mockCreateAndPool = vi.fn();
vi.mock("@/lib/pi/agent-pool", () => ({
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  get: (...args: unknown[]) => mockGetPoolEntry(...args),
  remove: vi.fn(),
  createAndPool: (...args: unknown[]) => mockCreateAndPool(...args),
}));

const mockEnsureWorktree = vi.fn();
vi.mock("@/lib/coder/worktrees", () => ({
  ensureWorktree: (...args: unknown[]) => mockEnsureWorktree(...args),
}));

const mockLoadChatUserSettings = vi.fn();
const mockCreateChatAgentSession = vi.fn();
vi.mock("@/lib/pi/chat-session-factory", () => ({
  loadChatUserSettings: (...args: unknown[]) => mockLoadChatUserSettings(...args),
  createChatAgentSession: (...args: unknown[]) => mockCreateChatAgentSession(...args),
}));

const mockEmit = vi.fn();
vi.mock("@/lib/pi/tool-approval-gate", () => ({
  createChatApprovalEmitter: () => mockEmit,
}));

const mockRegister = vi.fn();
const mockUnregister = vi.fn();
const mockMarkBuilding = vi.fn();
const mockClearBuilding = vi.fn();
vi.mock("@/lib/redis", () => ({
  registerActiveSession: (...args: unknown[]) => mockRegister(...args),
  unregisterActiveSession: (...args: unknown[]) => mockUnregister(...args),
  markAgentBuilding: (...args: unknown[]) => mockMarkBuilding(...args),
  clearAgentBuilding: (...args: unknown[]) => mockClearBuilding(...args),
}));

const mockPublish = vi.fn();
const mockResetEvents = vi.fn();
vi.mock("@/lib/pi/session-events", () => ({
  publishSessionEvent: (...args: unknown[]) => mockPublish(...args),
  resetSessionEvents: (...args: unknown[]) => mockResetEvents(...args),
}));

const mockWaitTeardown = vi.fn();
const mockWirePersistence = vi.fn();
vi.mock("@/lib/pi/session-persistence", () => ({
  waitForPersistenceTeardown: (...args: unknown[]) => mockWaitTeardown(...args),
  wireSessionPersistence: (...args: unknown[]) => mockWirePersistence(...args),
}));

const mockSubmitDeferring = vi.fn();
vi.mock("@/lib/pi/compaction-defer", () => ({
  submitDeferringToCompaction: (...args: unknown[]) => mockSubmitDeferring(...args),
}));

const mockClearToolState = vi.fn();
vi.mock("@/lib/chat/active-tool-state", () => ({
  clearActiveToolState: (...args: unknown[]) => mockClearToolState(...args),
}));

import { beginChatRun, dispatchChatRun, ensureChatAgent } from "@/lib/chat/agent-run";
import type { PooledChatSession } from "@/lib/chat/agent-run";
import { DEFAULT_AGENT_IDLE_TIMEOUT_MS } from "@/lib/pi/agent-idle-timeout";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const USER_ID = "user-1";
const SESSION_ID = "chat-1";
const CHAT = {
  modelProvider: "anthropic",
  modelName: "claude-sonnet-4-5",
  thinkingLevel: "off",
  toolConfig: null,
  projectId: null,
};

function makeEntry() {
  return {
    promptInFlight: false,
    lastPromptedMessageId: null as string | null,
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(() => () => {}),
      abort: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as PooledChatSession;
}

/** The `prompt` mock behind an entry, for assertions and failure setup. */
const promptMock = (entry: PooledChatSession) =>
  entry.session.prompt as unknown as ReturnType<typeof vi.fn>;

describe("ensureChatAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadChatUserSettings.mockResolvedValue({
      customInstructions: "Be brief.",
      toolPolicies: { bash: "ask" },
      toolExposure: { email: "codemode" },
    });
    mockCreateChatAgentSession.mockResolvedValue({ session: {}, sessionDir: "/sessions/chat-1" });
    mockCreateAndPool.mockImplementation(async (_key: string, create: () => unknown) => create());
    mockMarkBuilding.mockResolvedValue(undefined);
    mockClearBuilding.mockResolvedValue(undefined);
  });

  it("builds the agent with the user's settings and the approval channel on a miss", async () => {
    mockGetPoolEntry.mockReturnValue(undefined);

    const { entry, existedAlready } = await ensureChatAgent({
      userId: USER_ID,
      sessionId: SESSION_ID,
      chatSession: CHAT,
    });

    expect(existedAlready).toBe(false);
    expect(entry).toEqual({ session: {}, sessionDir: "/sessions/chat-1" });
    const options = mockCreateChatAgentSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.customInstructions).toBe("Be brief.");
    expect(options.toolPolicies).toEqual({ bash: "ask" });
    expect(options.toolExposure).toEqual({ email: "codemode" });
    // The session's gate publishes through this channel, and it is fixed when
    // the session is built.
    expect(options.emitApprovalRequest).toBe(mockEmit);
    expect(options.model).toBeUndefined();
  });

  it("passes an explicit model through", async () => {
    mockGetPoolEntry.mockReturnValue(undefined);

    await ensureChatAgent({
      userId: USER_ID,
      sessionId: SESSION_ID,
      chatSession: CHAT,
      model: { provider: "openai", name: "gpt-6" },
    });

    expect(mockCreateChatAgentSession.mock.calls[0]![0]).toMatchObject({
      model: { provider: "openai", name: "gpt-6" },
    });
  });

  it("reports an existing pool entry", async () => {
    mockGetPoolEntry.mockReturnValue({ session: {} });

    const { existedAlready } = await ensureChatAgent({
      userId: USER_ID,
      sessionId: SESSION_ID,
      chatSession: CHAT,
    });

    expect(existedAlready).toBe(true);
  });

  it("builds a coder chat in its worktree", async () => {
    mockGetPoolEntry.mockReturnValue(undefined);
    mockEnsureWorktree.mockResolvedValue({ path: "worktrees/saale/c-chat1", branch: "wt/c-chat1" });

    await ensureChatAgent({
      userId: USER_ID,
      sessionId: SESSION_ID,
      chatSession: { ...CHAT, projectId: "proj-1" },
    });

    expect(mockEnsureWorktree).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(mockCreateChatAgentSession.mock.calls[0]![0]).toMatchObject({
      workspaceCwd: "worktrees/saale/c-chat1",
    });
  });

  it("leaves a normal chat in the workspace", async () => {
    mockGetPoolEntry.mockReturnValue(undefined);

    await ensureChatAgent({ userId: USER_ID, sessionId: SESSION_ID, chatSession: CHAT });

    expect(mockEnsureWorktree).not.toHaveBeenCalled();
    const options = mockCreateChatAgentSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.workspaceCwd).toBeUndefined();
  });

  it("fails the pool creation when the worktree cannot be built", async () => {
    mockGetPoolEntry.mockReturnValue(undefined);
    mockEnsureWorktree.mockRejectedValue(new Error("fatal: invalid reference: main"));

    await expect(
      ensureChatAgent({
        userId: USER_ID,
        sessionId: SESSION_ID,
        chatSession: { ...CHAT, projectId: "proj-1" },
      }),
    ).rejects.toThrow(/invalid reference/);

    // No fallback to the workspace: a coder agent without a worktree must not exist.
    expect(mockCreateChatAgentSession).not.toHaveBeenCalled();
  });

  it("holds the chat busy for the whole build", async () => {
    mockGetPoolEntry.mockReturnValue(undefined);
    const order: string[] = [];
    mockMarkBuilding.mockImplementation(async () => {
      order.push("mark");
    });
    mockEnsureWorktree.mockImplementation(async () => {
      order.push("worktree");
      return { path: "worktrees/saale/c-chat1", branch: "wt/c-chat1", mode: "worktree" };
    });
    mockClearBuilding.mockImplementation(async () => {
      order.push("clear");
    });

    await ensureChatAgent({
      userId: USER_ID,
      sessionId: SESSION_ID,
      chatSession: { ...CHAT, projectId: "proj-1" },
    });

    // A message sent during the build has to queue behind it instead of
    // claiming a prompt the build is not going to deliver.
    expect(order).toEqual(["mark", "worktree", "clear"]);
  });

  it("releases the chat when the build fails", async () => {
    mockGetPoolEntry.mockReturnValue(undefined);
    mockEnsureWorktree.mockRejectedValue(new Error("checkout gone"));

    await expect(
      ensureChatAgent({
        userId: USER_ID,
        sessionId: SESSION_ID,
        chatSession: { ...CHAT, projectId: "proj-1" },
      }),
    ).rejects.toThrow(/checkout gone/);

    expect(mockClearBuilding).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe("beginChatRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClearToolState.mockResolvedValue(undefined);
    mockRegister.mockResolvedValue(undefined);
    mockResetEvents.mockResolvedValue(undefined);
    mockWaitTeardown.mockResolvedValue(undefined);
  });

  it("registers the generation and wires persistence", async () => {
    const session = { id: "agent-session" } as unknown as AgentSession;
    await beginChatRun({ userId: USER_ID, sessionId: SESSION_ID, session });

    expect(mockClearToolState).toHaveBeenCalledWith(SESSION_ID, USER_ID);
    expect(mockRegister).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(mockWirePersistence).toHaveBeenCalledWith(SESSION_ID, USER_ID, session);
    // Persistence must be wired only after the previous run tore down, or the
    // run would go unpersisted and double-publish events.
    expect(mockWaitTeardown.mock.invocationCallOrder[0]!).toBeLessThan(
      mockWirePersistence.mock.invocationCallOrder[0]!,
    );
  });

  it("still starts the run when clearing stale tool state fails", async () => {
    mockClearToolState.mockRejectedValue(new Error("db down"));

    await beginChatRun({
      userId: USER_ID,
      sessionId: SESSION_ID,
      session: {} as unknown as AgentSession,
    });

    expect(mockWirePersistence).toHaveBeenCalled();
  });
});

describe("dispatchChatRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubmitDeferring.mockImplementation(async (_session: unknown, run: () => unknown) => run());
    mockPublish.mockResolvedValue(1);
    mockResetEvents.mockResolvedValue(undefined);
    mockUnregister.mockResolvedValue(undefined);
  });

  it("prompts the session and releases the claim on success", async () => {
    const entry = makeEntry();

    const ok = await dispatchChatRun({
      userId: USER_ID,
      sessionId: SESSION_ID,
      entry,
      content: "hello",
    });

    expect(ok).toBe(true);
    expect(entry.session.prompt).toHaveBeenCalledWith("hello");
    expect(entry.promptInFlight).toBe(false);
  });

  it("passes image content when the message has attachments", async () => {
    const entry = makeEntry();

    await dispatchChatRun({
      userId: USER_ID,
      sessionId: SESSION_ID,
      entry,
      content: "look",
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
    });

    expect(entry.session.prompt).toHaveBeenCalledWith("look", {
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
    });
  });

  it("settles connected clients and releases the claim when the run fails", async () => {
    const entry = makeEntry();
    promptMock(entry).mockRejectedValue(new Error("provider exploded"));
    const onRunFailed = vi.fn();

    const ok = await dispatchChatRun({
      userId: USER_ID,
      sessionId: SESSION_ID,
      entry,
      content: "hello",
      onRunFailed,
    });

    expect(ok).toBe(false);
    expect(entry.promptInFlight).toBe(false);
    expect(entry.lastPromptedMessageId).toBeNull();
    expect(mockUnregister).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(mockPublish).toHaveBeenCalledWith(
      SESSION_ID,
      "error",
      expect.objectContaining({ message: "provider exploded" }),
    );
    expect(mockPublish).toHaveBeenCalledWith(SESSION_ID, "done", {});
    expect(mockResetEvents).toHaveBeenCalledWith(SESSION_ID);
    expect(onRunFailed).toHaveBeenCalled();
  });

  it("ends a silent run on the idle timeout and releases the claim", async () => {
    vi.useFakeTimers();
    try {
      const entry = makeEntry();
      // A provider stream that never closes: prompt() never settles.
      promptMock(entry).mockImplementation(() => new Promise<void>(() => {}));

      const run = dispatchChatRun({
        userId: USER_ID,
        sessionId: SESSION_ID,
        entry,
        content: "hello",
      });

      await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_IDLE_TIMEOUT_MS + 1);
      const ok = await run;

      expect(ok).toBe(false);
      // The stalled run is aborted and the claim released, so the chat can send
      // again instead of staying "busy" forever.
      expect(entry.session.abort).toHaveBeenCalled();
      expect(entry.promptInFlight).toBe(false);
      expect(mockPublish).toHaveBeenCalledWith(
        SESSION_ID,
        "error",
        expect.objectContaining({ message: expect.stringMatching(/stalled/i) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
