import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * `/compact` can be the request that brings a chat's agent into the pool (after
 * eviction, a restart, or a cold session). Tools are only approval-gated when
 * the session is built, so this route must build the same session the stream
 * route does — otherwise the pooled session runs tools without the user's
 * policy for the rest of its life.
 */

const {
  mockRequireChatSessionOwner,
  mockCreateAndPool,
  mockLoadChatUserSettings,
  mockResolveChatModel,
  mockCreateChatAgentSession,
  mockCompact,
  mockSaveCompactionMessage,
} = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockCreateAndPool: vi.fn(),
  mockLoadChatUserSettings: vi.fn(),
  mockResolveChatModel: vi.fn(),
  mockCreateChatAgentSession: vi.fn(),
  mockCompact: vi.fn(),
  mockSaveCompactionMessage: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireChatSessionOwner: mockRequireChatSessionOwner }));

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

import { POST } from "@/app/api/chat/sessions/[sessionId]/compact/route";

const USER_ID = "compact-user";
const SESSION_ID = "compact-session";
const CHAT_SESSION = {
  id: SESSION_ID,
  modelProvider: "anthropic",
  modelName: "claude-sonnet-4-5",
  thinkingLevel: "default",
  toolConfig: { terminal: true },
};

function compactRequest() {
  return POST(new NextRequest("http://localhost/api/chat/sessions/x/compact", { method: "POST" }), {
    params: Promise.resolve({ sessionId: SESSION_ID }),
  });
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

describe("POST /api/chat/sessions/[sessionId]/compact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      session: CHAT_SESSION,
    });
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
    const res = await compactRequest();
    expect(res.status).toBe(200);

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
    const result = (await options
      .wrapTool(makeTool("bash", () => (executed = true)))
      .execute("tc-1", { cmd: "rm -rf /" }, undefined, undefined, {} as never)) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };

    expect(executed).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("disabled");
  });

  it("persists the summary so the chat shows it", async () => {
    await compactRequest();
    expect(mockSaveCompactionMessage).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      summary: "Sum",
      tokensBefore: 1000,
    });
  });

  it("rejects a chat with no resolvable model", async () => {
    mockResolveChatModel.mockResolvedValue(undefined);
    const res = await compactRequest();
    expect(res.status).toBe(400);
    expect(mockCreateAndPool).not.toHaveBeenCalled();
  });

  it("maps Pi's already-compacted error to 409", async () => {
    mockCompact.mockRejectedValue(new Error("Already compacted"));
    const res = await compactRequest();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("already_compacted");
  });
});
