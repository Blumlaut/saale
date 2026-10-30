import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  chatSession: { id: "chat-1", projectId: null as string | null },
  prompts: [] as Array<Record<string, unknown>>,
  coderProjects: [] as Array<{ slug: string }>,
  db: {
    chatSession: { findFirst: vi.fn() },
    prompt: { findMany: vi.fn() },
    coderProject: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: hoisted.db }));

import { expandPromptInChat, promptsForChat } from "@/lib/prompts/chat";

function prompt(overrides: Record<string, unknown> = {}) {
  return {
    id: "prompt-1",
    userId: "user-1",
    name: "review",
    description: "Review the staged changes",
    argumentHint: "[focus]",
    scope: "any",
    content: "Review the staged changes. Focus on ${1:-correctness}.",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.chatSession = { id: "chat-1", projectId: null };
  hoisted.prompts = [prompt()];
  hoisted.db.chatSession.findFirst.mockImplementation(async () => hoisted.chatSession);
  hoisted.db.prompt.findMany.mockImplementation(async () => hoisted.prompts);
  hoisted.db.coderProject.findFirst.mockResolvedValue(null);
});

describe("promptsForChat", () => {
  it("offers the user's own prompts", async () => {
    const prompts = await promptsForChat("user-1", { id: "chat-1", projectId: null });

    expect(prompts.map((p) => p.name)).toEqual(["review"]);
    expect(hoisted.db.prompt.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { name: "asc" },
    });
  });

  it("drops a prompt scoped to the other surface", async () => {
    hoisted.prompts = [prompt({ scope: "coder" })];

    expect(await promptsForChat("user-1", { id: "chat-1", projectId: null })).toEqual([]);
    expect(await promptsForChat("user-1", { id: "chat-1", projectId: "project-1" })).toHaveLength(
      1,
    );
  });
});

describe("expandPromptInChat", () => {
  it("replaces the command with the prompt's content and its arguments", async () => {
    const text = await expandPromptInChat({
      userId: "user-1",
      sessionId: "chat-1",
      text: "/review security",
    });

    expect(text).toBe("Review the staged changes. Focus on security.");
    expect(hoisted.db.chatSession.findFirst).toHaveBeenCalledWith({
      where: { id: "chat-1", userId: "user-1" },
      select: { id: true, projectId: true },
    });
  });

  it("fills the default when no arguments are typed", async () => {
    expect(
      await expandPromptInChat({ userId: "user-1", sessionId: "chat-1", text: "/review" }),
    ).toBe("Review the staged changes. Focus on correctness.");
  });

  it("leaves ordinary text alone without reading anything", async () => {
    const text = await expandPromptInChat({
      userId: "user-1",
      sessionId: "chat-1",
      text: "review the diff",
    });

    expect(text).toBe("review the diff");
    expect(hoisted.db.prompt.findMany).not.toHaveBeenCalled();
  });

  it("leaves a built-in command to the command route", async () => {
    const text = await expandPromptInChat({
      userId: "user-1",
      sessionId: "chat-1",
      text: "/compact",
    });

    expect(text).toBe("/compact");
    expect(hoisted.db.prompt.findMany).not.toHaveBeenCalled();
  });

  it("leaves a name no prompt answers to alone", async () => {
    hoisted.prompts = [];

    expect(
      await expandPromptInChat({ userId: "user-1", sessionId: "chat-1", text: "/unknown src" }),
    ).toBe("/unknown src");
  });
});
