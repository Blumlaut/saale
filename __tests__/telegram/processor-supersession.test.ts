import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Regression tests for the burst bug: when many messages are forwarded to a
 * Telegram chat in quick succession, the messages queued behind the chat lock
 * used to each run to completion and send their own reply — spammed into the
 * chat at the end. Latest message must win: a run superseded by a newer
 * message bails out at its checkpoints (queued behind the lock, or still in
 * slow pre-session setup) and sends no reply.
 *
 * Everything the processor imports is mocked except `./chat-lock` and
 * `./session-registry` — those are the units under test.
 */

const h = vi.hoisted(() => {
  const definition = {
    id: "def-1",
    userId: "user-1",
    name: "Telegram Assistant",
    systemPrompt: "sp",
    toolConfig: { terminal: true },
    modelId: null,
    thinkingLevel: "off",
    enabled: true,
    systemManaged: true,
  };
  const prisma = {
    telegramLink: { findUnique: vi.fn(), update: vi.fn() },
    chatSession: { create: vi.fn(), update: vi.fn() },
    chatMessage: { findMany: vi.fn(), create: vi.fn() },
    chatAttachment: { create: vi.fn() },
    appSettings: { findUnique: vi.fn() },
    agentDefinition: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    agentRun: { create: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  };
  // Interactive transactions run against the same fake; the array form awaits.
  prisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
  return { prisma, definition };
});

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  SessionManager: { continueRecent: vi.fn(() => ({ getCwd: () => "/tmp/session" })) },
}));

vi.mock("@/lib/telegram/client", () => ({
  createBot: vi.fn(),
  sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
  startTypingIndicator: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: vi.fn().mockResolvedValue({
    modelRuntime: { getModel: () => ({ id: "model-1" }) },
  }),
}));

vi.mock("@/lib/pi/tool-registry", () => ({
  resolveTools: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/pi/model-resolution", () => ({
  resolveModelForPurpose: vi.fn().mockResolvedValue({ provider: "anthropic", name: "claude-test" }),
}));

vi.mock("@/lib/pi/thinking-levels", () => ({
  thinkingLevelOption: vi.fn(() => ({})),
}));

vi.mock("@/lib/pi/tool-categories", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pi/tool-categories")>()),
  DEFAULT_TOOL_CONFIG: {},
}));

vi.mock("@/lib/pi/tool-approval-gate", () => ({
  createToolApprovalGate: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("@/lib/pi/tool-summary-resolver", () => ({
  resolveToolSummary: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/telegram/approval", () => ({
  sendTelegramApprovalRequest: vi.fn().mockResolvedValue(null),
  deleteTelegramApprovalMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/telegram/approval-cards", () => ({
  createApprovalCardTracker: vi.fn(() => ({
    track: vi.fn(),
    onResolved: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@/lib/pi/stream-logic", () => ({
  extractCumulativeText: vi.fn(() => "Hello from the latest message"),
}));

vi.mock("@/lib/pi/provider-error", () => ({
  extractProviderError: vi.fn(() => null),
}));

vi.mock("@/lib/chat/compaction", () => ({
  saveCompactionMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pi/processing-state", () => ({
  buildAgentSystemPrompt: vi.fn(() => "system prompt"),
  createSystemPromptLoader: vi.fn().mockResolvedValue({}),
  createAgentResourceLoader: vi.fn().mockResolvedValue({}),
  startSessionExtensions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pi/settings", () => ({
  createSessionSettings: vi.fn(() => ({})),
}));

vi.mock("@/lib/pi/session", () => ({
  createTerminalScopedTools: vi.fn(() => []),
}));

vi.mock("@/lib/telegram/files", () => ({
  downloadAndProcessTelegramFile: vi.fn(),
  buildFilePromptText: vi.fn(() => ""),
  TELEGRAM_FILES_DIR: "telegram-files",
}));

vi.mock("@/lib/redis", () => ({
  registerActiveSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pi/session-events", () => ({
  resetSessionEvents: vi.fn().mockResolvedValue(undefined),
  subscribeSessionEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pi/session-event-tracker", () => ({
  createSessionEventTracker: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("@/lib/pi/agent-idle-timeout", () => ({
  createAgentIdleTimeout: vi.fn(() => ({ clear: vi.fn() })),
}));

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { buildModelRuntime } from "@/lib/pi/models";
import { sendTelegramMessage } from "@/lib/telegram/client";
import {
  attachTelegramSession,
  interruptTelegramChat,
  isTelegramSessionActive,
  nextMessageSeq,
} from "@/lib/telegram/session-registry";
import { processTelegramMessage } from "@/lib/telegram/processor";

const USER = "user-1";
const ENCRYPTED_TOKEN = "token-1";

let chatCounter = 0;
function nextChatId(): bigint {
  return BigInt(1000 + ++chatCounter);
}

function baseParams(chatId: bigint) {
  return {
    userId: USER,
    encryptedToken: ENCRYPTED_TOKEN,
    telegramChatId: chatId,
    telegramUserId: BigInt(42),
    // Mirror the webhook: attach the session once the run creates it.
    onSessionCreated: (session: AgentSession, tgChatId: bigint) => {
      attachTelegramSession(USER, tgChatId, session);
    },
  };
}

/** A run's processingDone/`done` pair, as the webhook builds it. */
function makeDone() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { processingDone: { resolve }, donePromise: promise };
}

/**
 * A stand-in Pi session. Emits the given events (synchronously) when
 * `prompt()` is called — the real session emits asynchronously, but the
 * processor's handler order is what matters here.
 */
function makeFakeSession(events: Array<Record<string, unknown>> = []) {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const emit = (event: Record<string, unknown>) => {
    for (const listener of [...listeners]) listener(event);
  };
  const fake = {
    subscribe: (listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    prompt: vi.fn(async () => {
      for (const event of events) emit(event);
    }),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    getSessionStats: vi.fn(() => ({ tokens: { input: 10, output: 5 }, cost: 0.01 })),
  };
  return { session: fake as unknown as AgentSession, fake };
}

/** Existing link + session + definition, so the run takes the happy setup path. */
function setupPrisma(chatId: bigint) {
  // Partial mock values — `as never` follows the codebase's mocking convention.
  vi.mocked(prisma.telegramLink.findUnique).mockResolvedValue({
    id: "link-1",
    userId: "user-1",
    telegramUserId: chatId,
    telegramChatId: chatId,
    displayName: "Jane",
    sessionId: "session-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
  vi.mocked(prisma.telegramLink.update).mockResolvedValue({} as never);
  // A recent message exists → no new session is created.
  vi.mocked(prisma.chatMessage.findMany).mockResolvedValue([
    { id: "m0", createdAt: new Date() },
  ] as never);
  vi.mocked(prisma.chatMessage.create).mockResolvedValue({ id: "um1" } as never);
  vi.mocked(prisma.chatSession.update).mockResolvedValue({} as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.agentDefinition.findFirst).mockResolvedValue({ ...h.definition } as never);
  vi.mocked(prisma.agentDefinition.update).mockResolvedValue({ ...h.definition } as never);
  vi.mocked(prisma.agentRun.create).mockResolvedValue({ id: "run-1" } as never);
  vi.mocked(prisma.agentRun.update).mockResolvedValue({} as never);
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processTelegramMessage — latest message wins", () => {
  it("drops messages superseded while queued behind the chat lock; only the latest runs", async () => {
    const chatId = nextChatId();
    setupPrisma(chatId);

    const { session, fake } = makeFakeSession([
      {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
      { type: "agent_settled" },
    ]);
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    // A burst: m1's run is in flight when m2 and m3's webhooks arrive, so
    // their runs queue behind the chat lock — by the time they start, they
    // are no longer the latest message.
    const seq1 = nextMessageSeq(USER, chatId);
    const seq2 = nextMessageSeq(USER, chatId);
    const seq3 = nextMessageSeq(USER, chatId);

    await Promise.all([
      processTelegramMessage({
        ...baseParams(chatId),
        messageText: "first",
        replyToMessageId: 11,
        messageSeq: seq1,
        ...makeDone(),
      }),
      processTelegramMessage({
        ...baseParams(chatId),
        messageText: "second",
        replyToMessageId: 22,
        messageSeq: seq2,
        ...makeDone(),
      }),
      processTelegramMessage({
        ...baseParams(chatId),
        messageText: "third",
        replyToMessageId: 33,
        messageSeq: seq3,
        ...makeDone(),
      }),
    ]);

    // Only the latest message ran: one session, one prompt, one reply.
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(fake.prompt).toHaveBeenCalledTimes(1);
    expect(fake.prompt).toHaveBeenCalledWith("third", undefined);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      ENCRYPTED_TOKEN,
      chatId,
      "Hello from the latest message",
      { replyToMessageId: 33 },
    );

    // The superseded messages did no work: no run records, no user messages saved.
    expect(h.prisma.agentRun.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.chatMessage.create).toHaveBeenCalledTimes(1);

    // The finished run unregistered itself.
    expect(isTelegramSessionActive(USER, chatId)).toBe(false);
  });

  it("drops a message superseded during slow pre-session setup; no prompt, no reply, run cancelled", async () => {
    const chatId = nextChatId();
    setupPrisma(chatId);

    // Hold m1's run in slow setup (model runtime build) so a newer message
    // can arrive while the Pi session does not exist yet — the webhook's
    // interrupt then has nothing to abort and relies on the checkpoint.
    let releaseBuild!: () => void;
    vi.mocked(buildModelRuntime).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBuild = () =>
            resolve({ modelRuntime: { getModel: () => ({ id: "model-1" }) } } as never);
        }),
    );

    const { session, fake } = makeFakeSession();
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const seq1 = nextMessageSeq(USER, chatId);
    const processing = processTelegramMessage({
      ...baseParams(chatId),
      messageText: "first",
      replyToMessageId: 11,
      messageSeq: seq1,
      ...makeDone(),
    });

    // Wait until m1's run registered (at the start of the run, well before
    // the Pi session exists) — the interrupt below is pre-session.
    await waitFor(() => isTelegramSessionActive(USER, chatId));

    // m2's webhook: bump the sequence and supersede the active run.
    nextMessageSeq(USER, chatId);
    const interrupting = interruptTelegramChat(USER, chatId);

    // m1's setup finishes — it must notice its supersession before prompting.
    releaseBuild();
    await processing;
    await interrupting;

    // The run did reach the AgentRun record, but the session existed only
    // during setup: never prompted, disposed.
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(h.prisma.agentRun.create).toHaveBeenCalledTimes(1);
    expect(fake.prompt).not.toHaveBeenCalled();
    expect(fake.dispose).toHaveBeenCalledTimes(1);

    // No reply, and the run is reported cancelled.
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    const statuses = h.prisma.agentRun.update.mock.calls.map((call) => call[0]?.data?.status);
    expect(statuses).toContain("cancelled");

    // The run fully settled and left no active entry behind.
    expect(isTelegramSessionActive(USER, chatId)).toBe(false);
  });
});
