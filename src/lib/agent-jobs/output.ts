import { sendTypingIndicator } from "@/lib/telegram/client";
import { getTelegramBot } from "@/lib/telegram/bot";
import {
  resolveTelegramSendTarget,
  TelegramTargetError,
  type TelegramSendTarget,
} from "@/lib/telegram/chats";
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
 * Telegram has one destination by default. the user's linked chat. so an empty
 * `outputChannelId` resolves there. A definition that names a group (the chat id
 * `telegram_chats` reports) resolves through the same check `telegram_send`
 * uses, so a job cannot post into a group the user does not own or the bot has
 * left.
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
  /** A group chat id, when the definition posts to one instead of the user's chat. */
  outputChannelId?: string | null;
}): Promise<BuiltAgentOutput> {
  const { userId, outputChannel, outputChannelId } = params;

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
  if (!link && !outputChannelId) {
    return {
      error:
        "Telegram output is configured but this account has no linked Telegram user. The output was not delivered.",
    };
  }

  // A group target is validated against the caller's own rows, so a definition
  // that names someone else's chat fails here instead of posting into it.
  let target: TelegramSendTarget;
  try {
    target = await resolveTelegramSendTarget({ userId, target: outputChannelId });
  } catch (err) {
    if (!(err instanceof TelegramTargetError)) throw err;
    return { error: err.message };
  }

  const chatId = target.chatId;

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
  // Only a group delivery leaves a breadcrumb: a private message is already
  // what the home thread is.
  const sentTo = target.group ? (target.label ?? "group") : null;

  return {
    output: {
      async send(content) {
        if (selfDelivered) return;

        const delivery = await deliverTelegramMessage({
          userId,
          encryptedToken: bot.encryptedToken,
          chatId,
          content,
          sentTo,
        });
        if (!delivery.ok && delivery.error) {
          failures.push(delivery.error);
        }
      },
      noteToolCall(call) {
        if (call.isError || call.name !== TELEGRAM_SEND_TOOL_NAME) return;

        // A successful send reports its chat, so a message to this run's own
        // target silences the channel. A send to some other chat does not.
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
