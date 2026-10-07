import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * `/compact` can be the request that brings a chat's agent into the pool (after
 * eviction, a restart, or a cold session). Tools are only approval-gated when
 * the session is built, so this path must build the same session the stream
 * route does — otherwise the pooled session runs tools without the user's
 * policy for the rest of its life.
 */

const {
  mockChatSessionFindFirst,
  mockCreateAndPool,
  mockLoadChatUserSettings,
  mockResolveChatModel,
  mockCreateChatAgentSession,
  mockCompact,
  mockSaveCompactionMessage,
  mockMarkCompactionInProgress,
  mockClearCompactionInProgress,
} = vi.hoisted(() => ({
  mockChatSessionFindFirst: vi.fn(),
  mockCreateAndPool: vi.fn(),
  mockLoadChatUserSettings: vi.fn(),
  mockResolveChatModel: vi.fn(),
  mockCreateChatAgentSession: vi.fn(),
  mockCompact: vi.fn(),
  mockSaveCompactionMessage: vi.fn(),
  mockMarkCompactionInProgress: vi.fn().mockResolvedValue(undefined),
  mockClearCompactionInProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  prisma: { chatSession: { findFirst: mockChatSessionFindFirst } },
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  createAndPool: mockCreateAndPool,
}));

vi.mock("@/lib/pi/chat-session-factory", () => ({
  loadChatUserSettings: mockLoadChatUserSettings,
  resolveChatModel: mockResolveChatModel,
  createChatAgentSession: mockCreateChatAgentSession,
}));

vi.mock("@/lib/chat/compaction", () => ({
  saveCompactionMessage: mockSaveCompactionMessage,
}));

vi.mock("@/lib/pi/session-events", () => ({
  publishSessionEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/redis", () => ({
  markCompactionInProgress: mockMarkCompactionInProgress,
  clearCompactionInProgress: mockClearCompactionInProgress,
}));

import { compactChatSession } from "@/lib/chat/compact-chat";

const USER_ID = "compact-user";
const SESSION_ID = "compact-session";
const CHAT_SESSION = {
  id: SESSION_ID,
  userId: USER_ID,
  modelProvider: "anthropic",
  modelName: "claude-sonnet-4-5",
  thinkingLevel: "default",
  toolConfig: { terminal: true },
};

function compact() {
  return compactChatSession({ userId: USER_ID, sessionId: SESSION_ID });
}

function makeTool(name: string, executed: () => void): ToolDefinition {
  return {
    name,
    label: name,
    description: "test tool",
    parameters: {} as never,
    execute: async () => {
      executed();
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  } as unknown as ToolDefinition;
}

describe("compactChatSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatSessionFindFirst.mockResolvedValue(CHAT_SESSION);
    mockResolveChatModel.mockResolvedValue({ provider: "anthropic", name: "claude-sonnet-4-5" });
    mockLoadChatUserSettings.mockResolvedValue({
      customInstructions: "Be brief.",
      toolPolicies: { bash: "off" },
    });
    // createAndPool runs the factory and returns its result (as the real one does
    // on a pool miss).
    mockCreateAndPool.mockImplementation((_key: string, createFn: () => unknown) => createFn());
    mockCreateChatAgentSession.mockResolvedValue({
      session: { compact: mockCompact },
      sessionDir: "/tmp/compact",
    });
    mockCompact.mockResolvedValue({ summary: "Sum", tokensBefore: 1000 });
  });

  it("builds the chat session with the user's approval gate", async () => {
    const result = await compact();
    expect(result).toEqual({ ok: true, tokensBefore: 1000 });

    expect(mockCreateChatAgentSession).toHaveBeenCalledTimes(1);
    const options = mockCreateChatAgentSession.mock.calls[0]![0] as {
      customInstructions: string | null;
      wrapTool: (tool: ToolDefinition) => ToolDefinition;
    };
    expect(options.customInstructions).toBe("Be brief.");
    expect(typeof options.wrapTool).toBe("function");

    // The gate is real: the user disabled `bash`, so a bash call must be
    // rejected without reaching the tool.
    let executed = false;
    await expect(
      options
        .wrapTool(makeTool("bash", () => (executed = true)))
        .execute("tc-1", { cmd: "rm -rf /" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/disabled/);
    expect(executed).toBe(false);
  });

  it("persists the summary so the chat shows it", async () => {
    await compact();
    expect(mockSaveCompactionMessage).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      summary: "Sum",
      tokensBefore: 1000,
    });
  });

  it("scrolls only the caller's own session", async () => {
    mockChatSessionFindFirst.mockResolvedValue(null);

    const result = await compact();

    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(mockChatSessionFindFirst).toHaveBeenCalledWith({
      where: { id: SESSION_ID, userId: USER_ID },
    });
    expect(mockCreateAndPool).not.toHaveBeenCalled();
  });

  it("rejects a chat with no resolvable model", async () => {
    mockResolveChatModel.mockResolvedValue(undefined);

    const result = await compact();

    expect(result).toMatchObject({ ok: false, code: "no-model" });
    expect(mockCreateAndPool).not.toHaveBeenCalled();
  });

  it("reports Pi's already-compacted error without treating it as a failure", async () => {
    mockCompact.mockRejectedValue(new Error("Already compacted"));

    const result = await compact();

    expect(result).toMatchObject({ ok: false, code: "already-compacted" });
  });

  it("reports a too-small conversation", async () => {
    mockCompact.mockRejectedValue(new Error("Nothing to compact (session too small)"));

    const result = await compact();

    expect(result).toMatchObject({ ok: false, code: "nothing-to-compact" });
  });

  it("keeps the session marked as compacting until the summary is generated", async () => {
    // Pi refuses a prompt while it compacts, so the session must read as busy
    // for as long as the summarization runs — POST /messages queues on it.
    let releaseCompact: (result: { summary: string; tokensBefore: number }) => void = () => {};
    mockCompact.mockImplementation(
      () =>
        new Promise<{ summary: string; tokensBefore: number }>((resolve) => {
          releaseCompact = resolve;
        }),
    );

    const pending = compact();
    await vi.waitFor(() => expect(mockCompact).toHaveBeenCalled());

    expect(mockMarkCompactionInProgress).toHaveBeenCalledWith(SESSION_ID);
    expect(mockClearCompactionInProgress).not.toHaveBeenCalled();

    releaseCompact({ summary: "Sum", tokensBefore: 1000 });
    await expect(pending).resolves.toEqual({ ok: true, tokensBefore: 1000 });

    // Released once the session is free again — the queued messages are
    // delivered from here on.
    expect(mockClearCompactionInProgress).toHaveBeenCalledWith(SESSION_ID);
  });

  it("releases the session when the compaction fails", async () => {
    mockCompact.mockRejectedValue(new Error("provider exploded"));

    const result = await compact();

    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(mockClearCompactionInProgress).toHaveBeenCalledWith(SESSION_ID);
  });
});
