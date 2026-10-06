import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The chat category's write tools. `chat_respond` runs an agent in another
 * chat — the caller's own chat id must reach it so it can refuse a self-run —
 * and `chat_delete` delegates to the shared deletion helper. Both default to
 * the `ask` approval policy.
 */

const mockRespondInChat = vi.fn();
vi.mock("@/lib/chat/respond-in-chat", () => ({
  respondInChat: (...args: unknown[]) => mockRespondInChat(...args),
}));

const mockDeleteChatSession = vi.fn();
vi.mock("@/lib/chat/delete-session", () => ({
  deleteChatSession: (...args: unknown[]) => mockDeleteChatSession(...args),
}));

const mockCreateChatSessionRow = vi.fn();
vi.mock("@/lib/chat/create-session", () => ({
  createChatSessionRow: (...args: unknown[]) => mockCreateChatSessionRow(...args),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/terminal/client", () => ({ isConfigured: () => false }));

import { createChatTools } from "@/lib/pi/tools/chat-tools";
import { getDefaultPolicy } from "@/lib/pi/tool-infos";

const USER_ID = "user-123";
const CALLER_SESSION = "caller-chat";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = async (execute: any, params: Record<string, unknown>, signal?: AbortSignal) =>
  execute("call-1", params, signal, undefined, {} as never);

function toolNamed(name: string) {
  const tool = createChatTools(USER_ID, CALLER_SESSION).find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("createChatTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRespondInChat.mockResolvedValue({
      sessionId: "chat-1",
      title: "Trip planning",
      reply: "Packed and ready.",
    });
    mockDeleteChatSession.mockResolvedValue({ title: "Trip planning" });
    mockCreateChatSessionRow.mockResolvedValue({
      id: "chat-new",
      title: "New Chat",
      createdAt: new Date(),
    });
  });

  it("exposes search, respond, create and delete", () => {
    const names = createChatTools(USER_ID, CALLER_SESSION).map((t) => t.name);
    expect(names).toEqual(["chat_search", "chat_respond", "chat_create", "chat_delete"]);
  });

  it("asks before either write, and never asks for search", () => {
    expect(getDefaultPolicy("chat_search")).toBe("allow");
    expect(getDefaultPolicy("chat_respond")).toBe("ask");
    expect(getDefaultPolicy("chat_create")).toBe("ask");
    expect(getDefaultPolicy("chat_delete")).toBe("ask");
  });

  describe("chat_respond", () => {
    it("runs the target chat, passing the caller's own id so it cannot self-run", async () => {
      const tool = toolNamed("chat_respond");

      const result = await callExecute(tool.execute, {
        sessionId: "chat-1",
        message: "How did it go?",
      });

      expect(mockRespondInChat).toHaveBeenCalledWith({
        userId: USER_ID,
        sessionId: "chat-1",
        callerSessionId: CALLER_SESSION,
        message: "How did it go?",
        signal: undefined,
      });
      expect(result.content[0]!.text).toContain("Trip planning");
      expect(result.content[0]!.text).toContain("Packed and ready.");
      expect(result.details).toEqual({
        sessionId: "chat-1",
        title: "Trip planning",
        reply: "Packed and ready.",
      });
    });

    it("forwards the caller's abort signal, so Stop reaches the nested run", async () => {
      const controller = new AbortController();
      const tool = toolNamed("chat_respond");

      await callExecute(tool.execute, { sessionId: "chat-1", message: "hi" }, controller.signal);

      expect(mockRespondInChat).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it("surfaces a refused target as a tool error", async () => {
      mockRespondInChat.mockRejectedValue(new Error("A chat cannot respond to itself"));
      const tool = toolNamed("chat_respond");

      await expect(
        callExecute(tool.execute, { sessionId: CALLER_SESSION, message: "hi" }),
      ).rejects.toThrow("A chat cannot respond to itself");
    });
  });

  describe("chat_create", () => {
    it("creates a chat and runs its first turn", async () => {
      mockRespondInChat.mockResolvedValue({
        sessionId: "chat-new",
        title: "New Chat",
        reply: "On it.",
      });
      const tool = toolNamed("chat_create");

      const result = await callExecute(tool.execute, { message: "Book the trip", title: "Trip" });

      expect(mockCreateChatSessionRow).toHaveBeenCalledWith(USER_ID, { title: "Trip" });
      expect(mockRespondInChat).toHaveBeenCalledWith({
        userId: USER_ID,
        sessionId: "chat-new",
        callerSessionId: CALLER_SESSION,
        message: "Book the trip",
        signal: undefined,
      });
      expect(result.content[0]!.text).toContain("On it.");
      expect(result.details).toEqual({
        sessionId: "chat-new",
        title: "New Chat",
        reply: "On it.",
      });
    });
  });

  describe("chat_delete", () => {
    it("delegates to the shared deletion helper, scoped to the user", async () => {
      const tool = toolNamed("chat_delete");

      const result = await callExecute(tool.execute, { sessionId: "chat-1" });

      expect(mockDeleteChatSession).toHaveBeenCalledWith(USER_ID, "chat-1");
      expect(result.content[0]!.text).toContain("Trip planning");
    });

    it("surfaces a missing chat as a tool error", async () => {
      mockDeleteChatSession.mockRejectedValue(new Error("Chat not found: chat-9"));
      const tool = toolNamed("chat_delete");

      await expect(callExecute(tool.execute, { sessionId: "chat-9" })).rejects.toThrow(
        "Chat not found: chat-9",
      );
    });
  });
});
