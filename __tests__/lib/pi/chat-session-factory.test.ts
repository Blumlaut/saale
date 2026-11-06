import { describe, it, expect, vi, beforeEach } from "vitest";

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

const mockResolveApprovalDecisionModel = vi.fn();
vi.mock("@/lib/pi/decision-model", () => ({
  resolveApprovalDecisionModel: (...args: unknown[]) => mockResolveApprovalDecisionModel(...args),
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
    mockResolveApprovalDecisionModel.mockResolvedValue(null);
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

    it("carries the decision model the gate judges Auto calls with", async () => {
      mockResolveApprovalDecisionModel.mockResolvedValue({
        provider: "custom-llamacpp",
        id: "kev",
      });

      const settings = await loadChatUserSettings("user-1");

      expect(settings.approvalDecisionModel).toEqual({ provider: "custom-llamacpp", id: "kev" });
    });

    it("returns nulls when the user has no settings row", async () => {
      mockFindUnique.mockResolvedValue(null);
      const settings = await loadChatUserSettings("user-2");
      expect(settings).toEqual({
        customInstructions: null,
        coderCustomInstructions: null,
        toolPolicies: null,
        toolExposure: null,
        approvalDecisionModel: null,
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
    it("forwards the approval channel, prompt, model and tool config", async () => {
      const emitApprovalRequest = vi.fn();

      const created = await createChatAgentSession({
        userId: "user-1",
        sessionId: "chat-1",
        chatSession: CHAT,
        customInstructions: "Be brief.",
        toolPolicies: { bash: "ask" },
        toolExposure: { email: "deferred" },
        approvalDecisionModel: { provider: "custom-llamacpp", id: "kev" },
        emitApprovalRequest,
      });

      expect(created.sessionDir).toBe("/tmp/saale-test-uploads/pi_sessions/user-1/chat-1");
      expect(mockCreatePersistentSession).toHaveBeenCalledTimes(1);
      const options = mockCreatePersistentSession.mock.calls[0]![0] as Record<string, unknown>;

      // The session's gate publishes its approval requests through this
      // channel, and it is fixed when the session is built.
      expect(options.emitApprovalRequest).toBe(emitApprovalRequest);
      expect(options.toolPolicies).toEqual({ bash: "ask" });
      expect(options.toolExposure).toEqual({ email: "deferred" });
      // The gate is built with the session, so the model it asks is fixed here too.
      expect(options.approvalDecisionModel).toEqual({ provider: "custom-llamacpp", id: "kev" });
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

    it("hands a coder chat the workspace scope and its own policies", async () => {
      const create = (projectId: string | null) =>
        createChatAgentSession({
          userId: "user-1",
          sessionId: `chat-${projectId ?? "plain"}`,
          chatSession: { ...CHAT, projectId },
          customInstructions: null,
          toolPolicies: { bash: "ask" },
          toolExposure: null,
          emitApprovalRequest: vi.fn(),
        });

      await create("project-1");
      const coder = mockCreatePersistentSession.mock.calls[0]![0] as Record<string, unknown>;
      // The gate judges a coder chat's commands by the workspace, and writes and
      // edits stand open: that is the whole difference a coding chat gets.
      expect(coder.commandScope).toBe("workspace");
      expect(coder.toolPolicies).toEqual({ bash: "ask", write: "allow", edit: "allow" });

      await create(null);
      const chat = mockCreatePersistentSession.mock.calls[1]![0] as Record<string, unknown>;
      expect(chat.commandScope).toBeUndefined();
      expect(chat.toolPolicies).toEqual({ bash: "ask" });
    });

    it("keeps a coder chat's file tools off when the user turned them off", async () => {
      await createChatAgentSession({
        userId: "user-1",
        sessionId: "chat-off",
        chatSession: { ...CHAT, projectId: "project-1" },
        customInstructions: null,
        toolPolicies: { write: "off" },
        toolExposure: null,
        emitApprovalRequest: vi.fn(),
      });

      const options = mockCreatePersistentSession.mock.calls[0]![0] as Record<string, unknown>;
      expect(options.toolPolicies).toEqual({ write: "off", edit: "allow" });
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
        emitApprovalRequest: vi.fn(),
      });

      const options = mockCreatePersistentSession.mock.calls[0]![0] as Record<string, unknown>;
      expect(options.thinkingLevel).toBe("default");
    });
  });
});
