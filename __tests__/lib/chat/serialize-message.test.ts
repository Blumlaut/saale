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
    const message = serializeSharedChatMessage(row({ toolCalls: storedCalls }), "tok");

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
    const message = serializeSharedChatMessage(row(), "tok");

    expect(message.thinking).toBeUndefined();
    expect(message.attachments).toBeUndefined();
    expect(JSON.stringify(message)).not.toContain("internal reasoning");
  });

  it("keeps the token count on a compaction message, not its text", () => {
    const message = serializeSharedChatMessage(
      row({ role: "compaction", thinking: "14800", content: "summarised" }),
      "tok",
    );

    expect(message.compaction).toEqual({ tokensBefore: 14800 });
    expect(message.thinking).toBeUndefined();
  });

  // The picture is what the chat is about, so a share page may show it, and it
  // is fetched through the token that page already holds.
  it("points a rendered picture at the share endpoint, not at the workspace", () => {
    const message = serializeSharedChatMessage(
      row({
        toolCalls: JSON.stringify([
          {
            id: "tc-render",
            name: "generate_image",
            args: { prompt: "a fox" },
            result:
              'Rendered it\n{"_saaleImageMeta":{"path":"generated/9b1c.png","width":1024,"height":768}}',
            isError: false,
          },
        ]),
      }),
      "tok",
    );

    expect(message.toolCalls?.[0]?.image).toEqual({
      src: "/api/chat/sessions/share/tok/images/tc-render",
      width: 1024,
      height: 768,
    });
    expect(JSON.stringify(message)).not.toContain("generated/9b1c.png");
  });

  it("omits tool calls when the row has none", () => {
    expect(serializeSharedChatMessage(row(), "tok").toolCalls).toBeUndefined();
    expect(serializeSharedChatMessage(row({ toolCalls: "[]" }), "tok").toolCalls).toEqual([]);
  });
});
