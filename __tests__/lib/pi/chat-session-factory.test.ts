import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * The factory every chat entry point builds its Pi agent session with.
 *
 * Its contract matters for correctness, not just for tidiness: the tools are
 * only approval-gated if the wrapper is handed to `createPersistentSession`,
 * so a caller that skips it (as `/compact` used to) leaves a pooled session
 * whose tools execute without the user's policy.
 */

const mockFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { appSettings: { findUnique: (...args: unknown[]) => mockFindUnique(...args) } },
}));

const mockResolveModelForPurpose = vi.fn();
vi.mock("@/lib/pi/model-resolution", () => ({
  resolveModelForPurpose: (...args: unknown[]) => mockResolveModelForPurpose(...args),
}));

const mockCreatePersistentSession = vi.fn();
vi.mock("@/lib/sandbox/env", () => ({ listSandboxEnvNames: vi.fn(async () => []) }));

vi.mock("@/lib/pi/persistent-session", () => ({
  createPersistentSession: (...args: unknown[]) => mockCreatePersistentSession(...args),
}));

import {
  createChatAgentSession,
  loadChatUserSettings,
  resolveChatModel,
  type ChatSessionModelConfig,
} from "@/lib/pi/chat-session-factory";

const CHAT: ChatSessionModelConfig = {
  modelProvider: "anthropic",
  modelName: "claude-sonnet-4-5",
  thinkingLevel: "high",
  toolConfig: { terminal: true, memory: false },
  projectId: null,
};

describe("chat session factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.UPLOADS_DIR = "/tmp/saale-test-uploads";
    mockCreatePersistentSession.mockResolvedValue({ session: { id: "agent-session" } });
    mockFindUnique.mockResolvedValue({
      agentCustomInstructions: "Be brief.",
      coderCustomInstructions: "Never add a dependency without asking.",
      toolPolicies: { bash: "ask" },
      toolExposure: { email: "codemode", jobs: "direct", not_a_category: "deferred" },
    });
  });

  describe("loadChatUserSettings", () => {
    it("returns the stored instructions, tool policies and exposure", async () => {
      const settings = await loadChatUserSettings("user-1");
      expect(settings.customInstructions).toBe("Be brief.");
      expect(settings.coderCustomInstructions).toBe("Never add a dependency without asking.");
      expect(settings.toolPolicies).toEqual({ bash: "ask" });
      // Unknown categories are dropped and entries at a category's default are
      // stored as absence, so a hand-edited row can never smuggle an invalid
      // exposure into a session.
      expect(settings.toolExposure).toEqual({ jobs: "direct" });
    });

    it("returns nulls when the user has no settings row", async () => {
      mockFindUnique.mockResolvedValue(null);
      const settings = await loadChatUserSettings("user-2");
      expect(settings).toEqual({
        customInstructions: null,
        coderCustomInstructions: null,
        toolPolicies: null,
        toolExposure: null,
      });
    });
  });

  describe("resolveChatModel", () => {
    it("prefers the model stored on the chat session", async () => {
      const model = await resolveChatModel("user-1", CHAT);
      expect(model).toEqual({ provider: "anthropic", name: "claude-sonnet-4-5" });
      expect(mockResolveModelForPurpose).not.toHaveBeenCalled();
    });

    it("falls back to the user's default chat model", async () => {
      mockResolveModelForPurpose.mockResolvedValue({ provider: "openai", name: "gpt-6" });
      const model = await resolveChatModel("user-1", { modelProvider: null, modelName: null });
      expect(model).toEqual({ provider: "openai", name: "gpt-6" });
      expect(mockResolveModelForPurpose).toHaveBeenCalledWith("user-1", "chat", undefined);
    });

    it("returns undefined when no model can be resolved", async () => {
      mockResolveModelForPurpose.mockResolvedValue(undefined);
      expect(
        await resolveChatModel("user-1", { modelProvider: null, modelName: null }),
      ).toBeUndefined();
    });
  });

  describe("createChatAgentSession", () => {
    it("forwards the approval gate, prompt, model and tool config", async () => {
      const gate = (tool: ToolDefinition) => ({ ...tool, gated: true });
      const wrapTool = vi.fn(gate);
      const emitApprovalRequest = vi.fn();

      const created = await createChatAgentSession({
        userId: "user-1",
        sessionId: "chat-1",
        chatSession: CHAT,
        customInstructions: "Be brief.",
        toolPolicies: { bash: "ask" },
        toolExposure: { email: "deferred" },
        wrapTool,
        emitApprovalRequest,
      });

      expect(created.sessionDir).toBe("/tmp/saale-test-uploads/pi_sessions/user-1/chat-1");
      expect(mockCreatePersistentSession).toHaveBeenCalledTimes(1);
      const options = mockCreatePersistentSession.mock.calls[0]![0] as Record<string, unknown>;

      // The gate is what enforces tool policies  it must reach the session,
      // and MCP tools (registered after the session exists) need the same
      // policies plus an approval channel of their own.
      expect(options.wrapTool).toBe(wrapTool);
      expect(options.emitApprovalRequest).toBe(emitApprovalRequest);
      expect(options.toolPolicies).toEqual({ bash: "ask" });
      expect(options.toolExposure).toEqual({ email: "deferred" });
      expect(options.mcp).toBe(true);
      expect(options.modelProvider).toBe("anthropic");
      expect(options.modelName).toBe("claude-sonnet-4-5");
      expect(options.thinkingLevel).toBe("high");
      expect(options.toolConfig).toEqual({ terminal: true, memory: false });
      // Saale's own prompt, never Pi's default coding-agent prompt.
      expect(String(options.systemPrompt)).toContain("You are Saale");
      expect(String(options.systemPrompt)).toContain("Be brief.");
      expect(created.session).toBeDefined();
    });

    it("gives a coder chat its own instructions instead of the chat persona", async () => {
      const create = (projectId: string | null, sessionId: string) =>
        createChatAgentSession({
          userId: "user-1",
          sessionId,
          chatSession: { ...CHAT, projectId },
          customInstructions: "Be brief.",
          coderCustomInstructions: "Never add a dependency without asking.",
          toolPolicies: null,
          toolExposure: null,
          wrapTool: (tool) => tool,
          emitApprovalRequest: vi.fn(),
        });

      await create("project-1", "chat-coder");
      const coderPrompt = String(
        (mockCreatePersistentSession.mock.calls[0]![0] as Record<string, unknown>).systemPrompt,
      );

      // A coder chat keeps the coder identity and reads the coder instructions
      // only: an instruction meant for a conversation can be wrong for a
      // worktree, which is why the two are separate settings.
      expect(coderPrompt).toContain("Saale's coding agent");
      expect(coderPrompt).toContain("Never add a dependency without asking.");
      expect(coderPrompt).not.toContain("Be brief.");

      await create(null, "chat-plain");
      const chatPrompt = String(
        (mockCreatePersistentSession.mock.calls[1]![0] as Record<string, unknown>).systemPrompt,
      );
      expect(chatPrompt).toContain("Be brief.");
      expect(chatPrompt).not.toContain("Never add a dependency without asking.");
    });

    it("uses the resolved fallback model when the chat has none", async () => {
      await createChatAgentSession({
        userId: "user-1",
        sessionId: "chat-2",
        chatSession: {
          modelProvider: null,
          modelName: null,
          thinkingLevel: "off",
          toolConfig: null,
          projectId: null,
        },
        model: { provider: "openai", name: "gpt-6" },
        customInstructions: null,
        toolPolicies: null,
        toolExposure: null,
        wrapTool: (tool) => tool,
        emitApprovalRequest: vi.fn(),
      });

      const options = mockCreatePersistentSession.mock.calls[0]![0] as Record<string, unknown>;
      expect(options.modelProvider).toBe("openai");
      expect(options.modelName).toBe("gpt-6");
      expect(options.toolConfig).toEqual({});
    });

    it("forwards the stored thinking level unchanged for Saale's 'default' setting", async () => {
      // "default" means "no opinion", so the factory must not translate it:
      // `thinkingLevelOption` in createPersistentSession drops it, letting Pi
      // keep the level recorded in the session transcript.
      await createChatAgentSession({
        userId: "user-1",
        sessionId: "chat-3",
        chatSession: { ...CHAT, thinkingLevel: "default" },
        customInstructions: null,
        toolPolicies: null,
        toolExposure: null,
        wrapTool: (tool) => tool,
        emitApprovalRequest: vi.fn(),
      });

      const options = mockCreatePersistentSession.mock.calls[0]![0] as Record<string, unknown>;
      expect(options.thinkingLevel).toBe("default");
    });
  });
});
