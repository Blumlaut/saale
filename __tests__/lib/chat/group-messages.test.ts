import { describe, it, expect } from "vitest";
import { groupMessages } from "@/lib/chat/group-messages";
import type { Message } from "@/components/chat/types";

function msg(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: "assistant",
    content: "",
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments: undefined,
    ...overrides,
  };
}

describe("groupMessages", () => {
  it("groups a simple user → assistant exchange", () => {
    const groups = groupMessages([
      msg({ id: "u1", role: "user" }),
      msg({ id: "a1", role: "assistant" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ type: "user", message: expect.objectContaining({ id: "u1" }) });
    expect(groups[1]).toEqual({
      type: "assistant-group",
      messages: [expect.objectContaining({ id: "a1" })],
    });
  });

  it("groups multi-turn assistant runs into a single bubble via parentMessageId", () => {
    const groups = groupMessages([
      msg({ id: "a-root", parentMessageId: undefined }),
      msg({ id: "a-child-1", parentMessageId: "a-root" }),
      msg({ id: "a-child-2", parentMessageId: "a-root" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      type: "assistant-group",
      messages: ["a-root", "a-child-1", "a-child-2"].map((id) => expect.objectContaining({ id })),
    });
  });

  it("breaks the group when a child belongs to a different run", () => {
    const groups = groupMessages([
      msg({ id: "a1", parentMessageId: undefined }),
      msg({ id: "a2", parentMessageId: "other-root" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.type).toBe("assistant-group");
    expect(groups[1]!.type).toBe("assistant-group");
  });

  it("treats system messages like user messages (standalone bubble)", () => {
    const groups = groupMessages([msg({ id: "s1", role: "system" })]);
    expect(groups[0]).toEqual({ type: "user", message: expect.objectContaining({ id: "s1" }) });
  });

  it("renders compaction messages as standalone cards", () => {
    const groups = groupMessages([
      msg({ id: "u1", role: "user" }),
      msg({ id: "c1", role: "compaction" }),
      msg({ id: "u2", role: "user" }),
    ]);

    expect(groups.map((g) => g.type)).toEqual(["user", "compaction", "user"]);
  });

  it("skips unknown roles defensively", () => {
    const groups = groupMessages([
      msg({ id: "x1", role: "toolResult" as Message["role"] }),
      msg({ id: "u1", role: "user" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ type: "user", message: expect.objectContaining({ id: "u1" }) });
  });

  it("returns an empty array for no messages", () => {
    expect(groupMessages([])).toEqual([]);
  });
});
