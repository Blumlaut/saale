import { describe, it, expect } from "vitest";
import {
  isStreamingMessage,
  isTempMessage,
  isTempUserMessage,
  makeCompactionMessage,
  makeStreamingMessage,
  makeTempUserMessage,
} from "@/lib/chat/message-factories";

describe("message ID predicates", () => {
  it("isStreamingMessage matches streaming-* ids", () => {
    expect(isStreamingMessage({ id: "streaming-abc" })).toBe(true);
    expect(isStreamingMessage({ id: "db-1" })).toBe(false);
  });

  it("isTempMessage matches any temp-* id", () => {
    expect(isTempMessage({ id: "temp-123" })).toBe(true);
    expect(isTempMessage({ id: "temp-compaction-9" })).toBe(true);
    expect(isTempMessage({ id: "db-1" })).toBe(false);
  });

  it("isTempUserMessage only matches optimistic USER messages", () => {
    const user = { id: "temp-1", role: "user" as const };
    const compaction = { id: "temp-compaction-1", role: "compaction" as const };
    expect(isTempUserMessage(user)).toBe(true);
    expect(isTempUserMessage(compaction)).toBe(false);
    expect(isTempUserMessage({ id: "db-1", role: "user" as const })).toBe(false);
  });
});

describe("makeTempUserMessage", () => {
  it("creates an optimistic user message without attachments", () => {
    const m = makeTempUserMessage("hello");
    expect(m).toMatchObject({
      role: "user",
      content: "hello",
      attachments: undefined,
      parentMessageId: undefined,
    });
    expect(m.id).toMatch(/^temp-\d+$/);
  });

  it("maps files to temp attachment metadata", () => {
    const files = [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.jpg", { type: "image/jpeg" }),
    ];
    const m = makeTempUserMessage("look", files);
    expect(m.attachments).toHaveLength(2);
    expect(m.attachments![0]).toMatchObject({
      storageId: "temp-a.png",
      fileName: "a.png",
      mimeType: "image/png",
      size: 1,
    });
    expect(m.attachments![1]!.storageId).toBe("temp-b.jpg");
  });
});

describe("makeStreamingMessage", () => {
  it("creates a live assistant turn with the streaming id scheme", () => {
    const m = makeStreamingMessage("turn-1", undefined);
    expect(m).toMatchObject({
      id: "streaming-turn-1",
      role: "assistant",
      content: "",
      thinking: undefined,
      toolCalls: undefined,
    });
    expect(m.parentMessageId).toBeUndefined();
  });

  it("sets parentMessageId from the root and applies the patch", () => {
    const m = makeStreamingMessage("turn-2", "root-1", { content: "seeded" });
    expect(m.parentMessageId).toBe("root-1");
    expect(m.content).toBe("seeded");
  });

  it("treats empty parent as undefined", () => {
    const m = makeStreamingMessage("turn-3", undefined);
    expect(m.parentMessageId).toBeUndefined();
  });
});

describe("makeCompactionMessage", () => {
  it("creates a compaction message with token count and default id", () => {
    const m = makeCompactionMessage("summary", 42);
    expect(m).toMatchObject({
      role: "compaction",
      content: "summary",
      compaction: { tokensBefore: 42 },
    });
    expect(m.id).toMatch(/^compaction-\d+$/);
  });

  it("accepts an explicit id (optimistic placeholder)", () => {
    const m = makeCompactionMessage("", 0, "temp-compaction-9");
    expect(m.id).toBe("temp-compaction-9");
  });
});
