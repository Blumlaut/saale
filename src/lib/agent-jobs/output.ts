import { sendTypingIndicator } from "@/lib/telegram/client";
import { getTelegramBot } from "@/lib/telegram/bot";
import { getLinkByUserId } from "@/lib/telegram/links";
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
 * channel (e.g., Telegram) based on the job definition's `outputChannel`.
 *
 * Telegram has exactly one destination per user. their linked chat. so there
 * is nothing to choose: the handler resolves the caller's own link and sends
 * there. `AgentDefinition.outputChannelId` is therefore not consulted; it
 * remains for channels that do have several targets.
 *
 * Returns an empty result when no channel is configured (nothing to deliver is
 * not a failure), and an `error` when a channel *is* configured but cannot be
 * resolved. Delivery failures that happen later. Telegram rejecting the send
 * are collected by the handler and surfaced through
 * `AgentOutput.deliveryErrors()`, which the caller records after the run.
 */
export async function buildAgentOutputHandler(params: {
  userId: string;
  outputChannel: string | null;
}): Promise<BuiltAgentOutput> {
  const { userId, outputChannel } = params;

  if (!outputChannel) {
    return {};
  }

  if (outputChannel !== "telegram") {
    const error = `Output channel "${outputChannel}" is not supported yet. the run's output was not delivered.`;
    console.warn(`[agent-jobs] ${error} (user ${userId})`);
    return { error };
  }

  const bot = await getTelegramBot();
  if (!bot || !bot.enabled) {
    return {
      error: bot
        ? "Telegram output is configured but the Telegram bot is switched off. The output was not delivered."
        : "Telegram output is configured but no Telegram bot is set up on this instance. The output was not delivered.",
    };
  }

  const link = await getLinkByUserId(userId);
  if (!link) {
    return {
      error:
        "Telegram output is configured but this account has no linked Telegram user. The output was not delivered.",
    };
  }

  const chatId = link.telegramChatId;

  // Delivery failures accumulate here as the run produces output; the caller
  // reads them once the run has settled so they land on the run record.
  const failures: string[] = [];

  // Set once the agent has messaged this chat itself through `telegram_send`.
  // A run can have both an output channel and the tool (the category is on by
  // default), and then the agent's closing text is the same message it just
  // sent. forwarding it would deliver everything twice. Once it has reached
  // this chat itself, the runner leaves delivery to it.
  let selfDelivered = false;
  const targetChatId = chatId.toString();

  return {
    output: {
      async send(content) {
        if (selfDelivered) return;

        const delivery = await deliverTelegramMessage({
          userId,
          encryptedToken: bot.encryptedToken,
          chatId,
          content,
        });
        if (!delivery.ok && delivery.error) {
          failures.push(delivery.error);
        }
      },
      noteToolCall(call) {
        if (call.isError || call.name !== TELEGRAM_SEND_TOOL_NAME) return;

        // A successful send reports its chat, so a message to the user's own
        // chat silences this channel. There is no other target to compare
        // against now. every telegram_send goes to the user's link.
        const delivered = (call.structured as { chatId?: unknown } | undefined)?.chatId;
        if (typeof delivered === "string" && delivered !== targetChatId) return;
        selfDelivered = true;
      },
      typing() {
        sendTypingIndicator(bot.encryptedToken, chatId);
      },
      deliveryErrors() {
        return [...failures];
      },
    },
  };
}
