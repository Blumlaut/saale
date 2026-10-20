import { describe, it, expect } from "vitest";
import {
  serializeSharedChatMessage,
  type ShareableChatMessage,
} from "@/lib/chat/serialize-message";

/**
 * `serializeSharedChatMessage` is the only way a share payload is built, so it
 * is where the redaction of a shared chat has to hold  regardless of which
 * endpoint is asking.
 */
function row(overrides: Partial<ShareableChatMessage> = {}): ShareableChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "Here is what I found.",
    thinking: "internal reasoning the owner should keep",
    errorMessage: null,
    toolCalls: null,
    parentMessageId: null,
    createdAt: new Date("2025-06-01T10:00:00.000Z"),
    ...overrides,
  };
}

const storedCalls = JSON.stringify([
  {
    id: "tc-1",
    name: "infra_exec",
    args: { machineId: "m1", command: "ffprobe /legoshiba/cloud/music/wolfgun.flac" },
    result: 'ffprobe output\n{"_saaleInfraMeta":{"machineName":"cloud-prod-environment"}}',
    isError: false,
  },
  {
    id: "tc-2",
    name: "mail_read",
    args: { id: "e1" },
    result: 'From: ada@example.com\nSubject: Q3 bonus payout\n{"_saaleMailMeta":{"count":1}}',
    isError: true,
  },
]);

describe("serializeSharedChatMessage", () => {
  it("redacts tool calls instead of passing them through", () => {
    const message = serializeSharedChatMessage(row({ toolCalls: storedCalls }));

    expect(message.toolCalls).toEqual([
      expect.objectContaining({
        id: "tc-1",
        name: "infra_exec",
        args: {},
        result: undefined,
        error: undefined,
        status: "completed",
        redacted: "Ran a command in the terminal",
      }),
      expect.objectContaining({
        id: "tc-2",
        name: "mail_read",
        status: "error",
        redacted: "Read mail · 1 email",
      }),
    ]);

    const payload = JSON.stringify(message);
    for (const secret of [
      "/legoshiba",
      "cloud-prod-environment",
      "ffprobe",
      "ada@example.com",
      "Q3 bonus payout",
    ]) {
      expect(payload).not.toContain(secret);
    }
  });

  it("drops the owner's thinking and attachments", () => {
    const message = serializeSharedChatMessage(row());

    expect(message.thinking).toBeUndefined();
    expect(message.attachments).toBeUndefined();
    expect(JSON.stringify(message)).not.toContain("internal reasoning");
  });

  it("keeps the token count on a compaction message, not its text", () => {
    const message = serializeSharedChatMessage(
      row({ role: "compaction", thinking: "14800", content: "summarised" }),
    );

    expect(message.compaction).toEqual({ tokensBefore: 14800 });
    expect(message.thinking).toBeUndefined();
  });

  it("omits tool calls when the row has none", () => {
    expect(serializeSharedChatMessage(row()).toolCalls).toBeUndefined();
    expect(serializeSharedChatMessage(row({ toolCalls: "[]" })).toolCalls).toEqual([]);
  });
});
