import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The processor's own work is small now: it decides which chat a message
 * continues, downloads any attachment, and hands both to `runRoutedTelegramMessage`.
 * The run itself is covered by `routed-run.test.ts`; here the run is stubbed so
 * the routing, the prompt text and the refusal can be asserted directly.
 *
 * `./chat-lock` and `./session-registry` are real. the burst rule (a message
 * superseded by a newer one does nothing) lives there.
 */

const h = vi.hoisted(() => ({
  resolveTelegramTarget: vi.fn(),
  runRoutedTelegramMessage: vi.fn(),
  sendTelegramMessage: vi.fn(),
  createBot: vi.fn(),
  downloadAndProcessTelegramFile: vi.fn(),
  setActiveTelegramSession: vi.fn(),
}));

// `./files` is imported for its real `buildFilePromptText`, and it pulls in the
// db module; an empty stub keeps any import-time query out of the test.
vi.mock("@/lib/db", () => ({ prisma: {} }));

vi.mock("@/lib/telegram/routing", () => ({
  resolveTelegramTarget: (...args: unknown[]) => h.resolveTelegramTarget(...args),
}));

vi.mock("@/lib/telegram/routed-run", () => ({
  runRoutedTelegramMessage: (...args: unknown[]) => h.runRoutedTelegramMessage(...args),
}));

vi.mock("@/lib/telegram/client", () => ({
  createBot: (...args: unknown[]) => h.createBot(...args),
  sendTelegramMessage: (...args: unknown[]) => h.sendTelegramMessage(...args),
}));

vi.mock("@/lib/telegram/links", () => ({
  setActiveTelegramSession: (...args: unknown[]) => h.setActiveTelegramSession(...args),
}));

// Keep `buildFilePromptText` real. the caption formatting is part of what is
// asserted below.
vi.mock("@/lib/telegram/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telegram/files")>()),
  downloadAndProcessTelegramFile: (...args: unknown[]) => h.downloadAndProcessTelegramFile(...args),
}));

import { nextMessageSeq } from "@/lib/telegram/session-registry";
import { NO_CHAT_MESSAGE, processTelegramMessage } from "@/lib/telegram/processor";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = "user-1";
const TOKEN = "token-1";

let chatCounter = 0;
function nextChatId(): bigint {
  return BigInt(1000 + ++chatCounter);
}

function params(chatId: bigint, overrides: Record<string, unknown> = {}) {
  let resolve!: () => void;
  const donePromise = new Promise<void>((r) => {
    resolve = r;
  });

  return {
    userId: USER,
    encryptedToken: TOKEN,
    telegramChatId: chatId,
    telegramUserId: BigInt(42),
    messageText: "hello",
    messageSeq: nextMessageSeq(USER, chatId),
    processingDone: { resolve },
    donePromise,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveTelegramTarget.mockResolvedValue({ sessionId: "sess-active", via: "active" });
  h.runRoutedTelegramMessage.mockResolvedValue(undefined);
  h.sendTelegramMessage.mockResolvedValue([1]);
  h.downloadAndProcessTelegramFile.mockResolvedValue(undefined);
  h.setActiveTelegramSession.mockResolvedValue(undefined);
});

// ─── Routing ────────────────────────────────────────────────────────────────

describe("processTelegramMessage  routing", () => {
  it("runs the message in the chat it continues", async () => {
    const chatId = nextChatId();

    await processTelegramMessage(params(chatId, { replyToMessageId: 11 }));

    expect(h.resolveTelegramTarget).toHaveBeenCalledWith({
      userId: USER,
      telegramChatId: chatId,
      replyToMessageId: null,
    });
    expect(h.runRoutedTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        telegramChatId: chatId,
        sessionId: "sess-active",
        promptText: "hello",
        agentPrompt: "hello",
        replyToMessageId: 11,
      }),
    );
  });

  it("remembers the chat so the next message continues it", async () => {
    await processTelegramMessage(params(nextChatId()));

    expect(h.setActiveTelegramSession).toHaveBeenCalledWith(USER, "sess-active");
  });

  it("adds the quoted message to the prompt but stores the user's own words", async () => {
    const chatId = nextChatId();

    await processTelegramMessage(
      params(chatId, {
        messageText: "why did that fail?",
        replyToQuoted: { messageId: 9, text: "Deploy failed", from: "Saale" },
      }),
    );

    expect(h.resolveTelegramTarget).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: BigInt(9) }),
    );

    const call = h.runRoutedTelegramMessage.mock.calls[0]![0] as {
      promptText: string;
      agentPrompt: string;
    };
    expect(call.promptText).toBe("why did that fail?");
    expect(call.agentPrompt).toContain("Deploy failed");
    expect(call.agentPrompt).toContain("why did that fail?");
  });

  it("says so instead of inventing a chat when nothing resolves", async () => {
    const chatId = nextChatId();
    h.resolveTelegramTarget.mockResolvedValue(null);

    await processTelegramMessage(params(chatId, { replyToMessageId: 11 }));

    expect(h.runRoutedTelegramMessage).not.toHaveBeenCalled();
    expect(h.sendTelegramMessage).toHaveBeenCalledWith(TOKEN, chatId, NO_CHAT_MESSAGE, {
      replyToMessageId: 11,
      parseMode: "HTML",
    });
    expect(h.setActiveTelegramSession).not.toHaveBeenCalled();
  });
});

// ─── Attachments ────────────────────────────────────────────────────────────

describe("processTelegramMessage  attachments", () => {
  it("keeps the caption once and passes the image to the run", async () => {
    const chatId = nextChatId();
    const imageData = { type: "image" as const, data: "QUJD", mimeType: "image/jpeg" };
    h.downloadAndProcessTelegramFile.mockResolvedValue({
      imageData,
      mimeType: "image/jpeg",
      fileName: "tyres.jpg",
    });

    await processTelegramMessage(
      params(chatId, {
        messageText: "",
        messageCaption: "do the rear tyres fit?",
        fileInfo: { fileId: "f1", mimeType: "image/jpeg" },
      }),
    );

    const call = h.runRoutedTelegramMessage.mock.calls[0]![0] as {
      promptText: string;
      imageData: unknown;
      document?: unknown;
    };
    // The caption once, then the attachment note the agent needs to look at it.
    expect(call.promptText).toBe(
      "do the rear tyres fit?\n[Image attached: tyres.jpg (image/jpeg)]",
    );
    expect(call.imageData).toEqual(imageData);
    expect(call.document).toBeUndefined();
  });

  it("names a saved document in the prompt and hands it to the run", async () => {
    const chatId = nextChatId();
    const document = {
      filePath: "/tmp/workspace/report.pdf",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      size: 10,
    };
    h.downloadAndProcessTelegramFile.mockResolvedValue(document);

    await processTelegramMessage(
      params(chatId, {
        messageText: "",
        messageCaption: "summarise this",
        fileInfo: { fileId: "f2", mimeType: "application/pdf" },
      }),
    );

    const call = h.runRoutedTelegramMessage.mock.calls[0]![0] as {
      promptText: string;
      document?: unknown;
    };
    expect(call.promptText).toContain("summarise this");
    expect(call.promptText).toContain("report.pdf");
    expect(call.document).toEqual(document);
  });

  it("still runs the text when the download fails", async () => {
    const chatId = nextChatId();
    h.downloadAndProcessTelegramFile.mockRejectedValue(new Error("telegram 502"));

    await processTelegramMessage(
      params(chatId, {
        messageText: "what is this?",
        fileInfo: { fileId: "f3", mimeType: "application/pdf" },
      }),
    );

    expect(h.runRoutedTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ promptText: "what is this?" }),
    );
  });
});

// ─── Latest message wins ────────────────────────────────────────────────────

describe("processTelegramMessage  latest message wins", () => {
  it("drops a message superseded while queued behind the chat lock", async () => {
    const chatId = nextChatId();

    // The first run holds the lock until it settles; two more messages queue
    // behind it, and the middle one is superseded before its turn comes.
    let release!: () => void;
    h.runRoutedTelegramMessage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const firstRun = processTelegramMessage(params(chatId, { messageText: "first" }));
    await vi.waitFor(() => expect(h.runRoutedTelegramMessage).toHaveBeenCalledTimes(1));

    const secondRun = processTelegramMessage(params(chatId, { messageText: "second" }));
    const thirdRun = processTelegramMessage(params(chatId, { messageText: "third" }));

    release();
    await Promise.all([firstRun, secondRun, thirdRun]);

    const prompts = h.runRoutedTelegramMessage.mock.calls.map(
      (call) => (call[0] as { promptText: string }).promptText,
    );
    expect(prompts).toEqual(["first", "third"]);
  });
});
