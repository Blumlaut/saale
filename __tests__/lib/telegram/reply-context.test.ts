import { describe, it, expect } from "vitest";
import { extractQuotedMessage, buildQuotedContext } from "@/lib/telegram/reply-context";

describe("extractQuotedMessage", () => {
  it("extracts a text reply", () => {
    const quoted = extractQuotedMessage({
      message_id: 42,
      text: "Task due today: call the dentist",
      from: { first_name: "Saale", is_bot: true },
    });

    expect(quoted).toEqual({
      messageId: 42,
      text: "Task due today: call the dentist",
      fromBot: true,
      fromName: "Saale",
    });
  });

  it("falls back to the caption for a photo/document reply", () => {
    const quoted = extractQuotedMessage({
      message_id: 7,
      caption: "here is the invoice",
      from: { username: "alice", is_bot: false },
    });

    expect(quoted?.text).toBe("here is the invoice");
    expect(quoted?.fromBot).toBe(false);
    expect(quoted?.fromName).toBe("alice");
  });

  it("returns undefined when there is nothing quoted", () => {
    expect(extractQuotedMessage(undefined)).toBeUndefined();
    expect(extractQuotedMessage(null)).toBeUndefined();
    expect(extractQuotedMessage("nope")).toBeUndefined();
    expect(extractQuotedMessage({ message_id: 1 })).toBeUndefined();
    expect(extractQuotedMessage({ text: "no id" })).toBeUndefined();
  });

  it("defaults the sender name when the quoted message has no `from`", () => {
    const quoted = extractQuotedMessage({ message_id: 3, text: "orphan" });
    expect(quoted).toEqual({
      messageId: 3,
      text: "orphan",
      fromBot: false,
      fromName: "unknown",
    });
  });
});

describe("buildQuotedContext", () => {
  it("returns null when there is no quoted message", () => {
    expect(buildQuotedContext(undefined)).toBeNull();
  });

  it("labels a bot message as sent by the assistant", () => {
    const context = buildQuotedContext({
      messageId: 99,
      text: "Task due today: call the dentist",
      fromBot: true,
      fromName: "Saale",
    });

    expect(context).toContain("message #99");
    expect(context).toContain("you (the assistant)");
    expect(context).toContain("Task due today: call the dentist");
  });

  it("labels another user's message by name", () => {
    const context = buildQuotedContext({
      messageId: 12,
      text: "ping",
      fromBot: false,
      fromName: "alice",
    });

    expect(context).toContain("the user's contact alice");
  });

  it("truncates a long quoted message to keep the prompt bounded", () => {
    const context = buildQuotedContext({
      messageId: 1,
      text: "x".repeat(5000),
      fromBot: true,
      fromName: "Saale",
    });

    expect(context).toBeDefined();
    expect(context).toContain("…");
    // The quoted body plus the framing stays well under Telegram's 4096 cap.
    expect(context!.length).toBeLessThan(2200);
  });
});
