import { prisma } from "@/lib/db";
import { sendTypingIndicator } from "@/lib/telegram/client";
import { resolveDefaultTelegramChat } from "@/lib/telegram/chats";
import { deliverTelegramMessage } from "@/lib/telegram/notify";
import { TELEGRAM_SEND_TOOL_NAME } from "@/lib/pi/tools/telegram-tools";
import type { AgentOutput } from "./executor";

/**
 * The result of resolving a definition's output channel.
 *
 * A configured channel that cannot be resolved is an *error*, not an absence:
 * a job whose whole purpose is to tell the user something must not record
 * itself as a success when nothing was told. `error` is written to
 * `AgentRun.deliveryError` so the run is visibly undelivered in the UI.
 */
export interface BuiltAgentOutput {
  /** The handler to route assistant turns through, when a channel applies. */
  output?: AgentOutput;
  /** Why no handler could be built. Undefined when none was needed. */
  error?: string;
}

/**
 * Build an output handler that routes agent run responses to an external
 * channel (e.g., Telegram) based on the job definition's outputChannel /
 * outputChannelId fields.
 *
 * Returns an empty result when no channel is configured (nothing to deliver is
 * not a failure), and an `error` when a channel *is* configured but cannot be
 * resolved. Delivery failures that happen later — Telegram rejecting the send —
 * are collected by the handler and surfaced through
 * `AgentOutput.deliveryErrors()`, which the caller records after the run.
 */
export async function buildAgentOutputHandler(params: {
  userId: string;
  outputChannel: string | null;
  outputChannelId: string | null;
}): Promise<BuiltAgentOutput> {
  const { userId, outputChannel, outputChannelId } = params;

  if (!outputChannel) {
    return {};
  }

  if (outputChannel !== "telegram") {
    const error = `Output channel "${outputChannel}" is not supported yet — the run's output was not delivered.`;
    console.warn(`[agent-jobs] ${error} (user ${userId})`);
    return { error };
  }

  const account = await prisma.telegramAccount.findUnique({
    where: { userId },
    select: { id: true, encryptedToken: true, enabled: true },
  });

  if (!account) {
    return {
      error:
        "Telegram output is configured but no Telegram bot is connected. The output was not delivered.",
    };
  }

  if (!account.enabled) {
    return {
      error:
        "Telegram output is configured but the Telegram integration is disabled. The output was not delivered.",
    };
  }

  // No explicit chat ID → inherit the user's configured Telegram chat
  // (most recent conversation, else most recent whitelisted user).
  let chatId: bigint;
  if (outputChannelId) {
    try {
      chatId = BigInt(outputChannelId);
    } catch {
      return {
        error: `Telegram output is configured with an invalid chat ID "${outputChannelId}". The output was not delivered.`,
      };
    }
  } else {
    const resolved = await resolveDefaultTelegramChat(account.id);
    if (resolved === null) {
      return {
        error:
          "Telegram output is configured but no chat is available (message the bot first or set a chat ID). The output was not delivered.",
      };
    }
    chatId = resolved;
  }

  // Delivery failures accumulate here as the run produces output; the caller
  // reads them once the run has settled so they land on the run record.
  const failures: string[] = [];

  // Chats the agent already messaged itself through `telegram_send`. A run can
  // have both an output channel and the tool (the category is on by default),
  // and then the agent's closing text is the same message it just sent —
  // forwarding it would deliver everything twice. Once it has reached this
  // chat itself, the runner leaves delivery to it.
  const selfDeliveredChats = new Set<string>();
  const targetChatId = chatId.toString();

  return {
    output: {
      async send(content) {
        if (selfDeliveredChats.has(targetChatId)) return;

        const delivery = await deliverTelegramMessage({
          userId,
          encryptedToken: account.encryptedToken,
          chatId,
          content,
        });
        if (!delivery.ok && delivery.error) {
          failures.push(delivery.error);
        }
      },
      noteToolCall(call) {
        if (call.isError || call.name !== TELEGRAM_SEND_TOOL_NAME) return;

        // A successful send reports its chat, so a message to a *different*
        // chat (an explicit group target, say) does not silence this channel.
        const delivered = (call.structured as { chatId?: unknown } | undefined)?.chatId;
        selfDeliveredChats.add(typeof delivered === "string" ? delivered : targetChatId);
      },
      typing() {
        sendTypingIndicator(account.encryptedToken, chatId);
      },
      deliveryErrors() {
        return [...failures];
      },
    },
  };
}
