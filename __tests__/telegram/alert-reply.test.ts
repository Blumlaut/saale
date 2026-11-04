import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A Telegram reply end to end: what reaches the run, and in which chat.
 *
 * The processor, the routing rule and the outbound ledger are all real here;
 * only the database, the network client and the run itself are stubbed. The
 * unit tests either side of this one stub the rule out, so this is the only
 * place that checks the three of them agree on where a reply belongs.
 */

const h = vi.hoisted(() => ({
  chatSession: { findFirst: vi.fn(), create: vi.fn() },
  outbound: { findUnique: vi.fn() },
  getLinkByUserId: vi.fn(),
  setActiveTelegramSession: vi.fn(),
  expandPromptInChat: vi.fn(),
  runRoutedTelegramMessage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { chatSession: h.chatSession, telegramOutboundMessage: h.outbound },
}));

vi.mock("@/lib/telegram/bot", () => ({ TELEGRAM_BOT_ID: "global" }));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => h.getLinkByUserId(...args),
  setActiveTelegramSession: (...args: unknown[]) => h.setActiveTelegramSession(...args),
}));

vi.mock("@/lib/telegram/client", () => ({ createBot: vi.fn() }));

vi.mock("@/lib/prompts/chat", () => ({
  expandPromptInChat: (...args: unknown[]) => h.expandPromptInChat(...args),
}));

vi.mock("@/lib/telegram/routed-run", () => ({
  runRoutedTelegramMessage: (...args: unknown[]) => h.runRoutedTelegramMessage(...args),
}));

// `buildFilePromptText` stays real; the download needs no stub here because
// these messages carry no file.
vi.mock("@/lib/telegram/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telegram/files")>()),
  downloadAndProcessTelegramFile: vi.fn(),
}));

import { processTelegramMessage } from "@/lib/telegram/processor";
import { nextMessageSeq } from "@/lib/telegram/session-registry";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = "user-1";
const TOKEN = "token-1";
const TELEGRAM_CHAT = BigInt("119075844");
const ALERT_CHAT = "chat-alert";
const NEW_CHAT = "chat-new";

const link = {
  id: "link-1",
  userId: USER,
  telegramUserId: BigInt(42),
  telegramChatId: TELEGRAM_CHAT,
  displayName: "Jane",
  activeSessionId: null as string | null,
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

const ALERT = "CVE-2026-1 affects lodash. Update today.";

function params(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    encryptedToken: TOKEN,
    telegramChatId: TELEGRAM_CHAT,
    telegramUserId: BigInt(42),
    messageText: "does that reach us?",
    messageSeq: nextMessageSeq(USER, TELEGRAM_CHAT),
    ...overrides,
  };
}

/** The ledger row for the alert Saale sent to this chat. */
function ledgerKnows(source: string | null) {
  h.outbound.findUnique.mockResolvedValue({ userId: USER, sessionId: source });
}

/** Which of these chats the user still owns. */
function ownedChats(...ids: string[]) {
  h.chatSession.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    ids.includes(where.id ?? "") ? { id: where.id } : null,
  );
}

function runCall() {
  return h.runRoutedTelegramMessage.mock.calls[0]![0] as {
    sessionId: string;
    promptText: string;
    content: string;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getLinkByUserId.mockResolvedValue(link);
  h.setActiveTelegramSession.mockResolvedValue(undefined);
  h.expandPromptInChat.mockImplementation(async ({ text }: { text: string }) => text);
  h.runRoutedTelegramMessage.mockResolvedValue(undefined);
  h.outbound.findUnique.mockResolvedValue(null);
  h.chatSession.create.mockImplementation(async ({ data }: { data: { title: string } }) => ({
    id: NEW_CHAT,
    title: data.title,
    createdAt: new Date(),
  }));
  ownedChats(ALERT_CHAT);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("a reply to an automation alert", () => {
  it("runs in the alert's chat and carries the alert into the transcript", async () => {
    ledgerKnows(ALERT_CHAT);

    await processTelegramMessage(
      params({ replyToQuoted: { messageId: 90, text: ALERT, fromBot: true, fromName: "Saale" } }),
    );

    expect(h.outbound.findUnique).toHaveBeenCalledWith({
      where: { chatId_messageId: { chatId: TELEGRAM_CHAT, messageId: BigInt(90) } },
      select: { userId: true, sessionId: true },
    });
    expect(runCall().sessionId).toBe(ALERT_CHAT);
    // The user's words name the chat; the message keeps the quote.
    expect(runCall().promptText).toBe("does that reach us?");
    expect(runCall().content).toBe(
      `Replying to Saale in Telegram:\n> ${ALERT}\n\ndoes that reach us?`,
    );
    expect(h.setActiveTelegramSession).toHaveBeenCalledWith(USER, ALERT_CHAT);
    expect(h.chatSession.create).not.toHaveBeenCalled();
  });

  it("starts a chat when the alert's chat was deleted", async () => {
    ledgerKnows(ALERT_CHAT);
    ownedChats();

    await processTelegramMessage(
      params({ replyToQuoted: { messageId: 90, text: ALERT, fromBot: true, fromName: "Saale" } }),
    );

    expect(runCall().sessionId).toBe(NEW_CHAT);
    expect(runCall().content).toContain(`> ${ALERT}`);
    expect(h.chatSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: USER, title: "New Chat" }),
    });
  });

  it("starts a chat when the alert has no chat behind it", async () => {
    // A watcher that runs on its own delivers with no chat, so the ledger knows
    // the message and nothing else.
    ledgerKnows(null);

    await processTelegramMessage(
      params({ replyToQuoted: { messageId: 90, text: ALERT, fromBot: true, fromName: "Saale" } }),
    );

    expect(runCall().sessionId).toBe(NEW_CHAT);
    expect(runCall().content).toContain(`> ${ALERT}`);
  });

  it("leaves the quote out only when there is nothing quoted", async () => {
    await processTelegramMessage(params({ messageText: "morning" }));

    expect(runCall().content).toBe("morning");
    expect(runCall().promptText).toBe("morning");
  });

  it("names the new chat from the message, not from the quote", async () => {
    ledgerKnows(null);

    await processTelegramMessage(
      params({
        messageText: "what changed?",
        replyToQuoted: { messageId: 90, text: ALERT, fromBot: true, fromName: "Saale" },
      }),
    );

    // `createChatSessionRow` is given no title: an unnamed chat is named by the
    // run from the user's own words.
    expect(h.chatSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ title: "New Chat", titleSource: "default" }),
    });
    expect(runCall().promptText).toBe("what changed?");
  });
});
