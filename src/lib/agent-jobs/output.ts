import { prisma } from "@/lib/db";
import { sendTelegramMessage, sendTypingIndicator } from "@/lib/telegram/client";
import { resolveDefaultTelegramChat } from "@/lib/telegram/chats";
import type { AgentOutput } from "./executor";

/**
 * Build an output handler that routes agent run responses to an external
 * channel (e.g., Telegram) based on the job definition's outputChannel /
 * outputChannelId fields.
 *
 * Returns undefined when no channel is configured or the channel cannot be
 * resolved (missing Telegram account, invalid chat ID, unsupported channel) —
 * callers pass the result straight to executeAgentRun().
 *
 * Resolution failures are logged explicitly so a job that "succeeds" without
 * delivering its output is traceable instead of failing silently.
 */
export async function buildAgentOutputHandler(params: {
  userId: string;
  outputChannel: string | null;
  outputChannelId: string | null;
}): Promise<AgentOutput | undefined> {
  const { userId, outputChannel, outputChannelId } = params;

  if (!outputChannel) {
    return undefined;
  }

  if (outputChannel === "telegram") {
    const account = await prisma.telegramAccount.findUnique({
      where: { userId },
      select: { id: true, encryptedToken: true },
    });

    if (!account) {
      console.error(
        `[agent-jobs] Telegram output requested for user ${userId} but no Telegram account is configured — output will not be sent.`,
      );
      return undefined;
    }

    // No explicit chat ID → inherit the user's configured Telegram chat
    // (most recent conversation, else most recent whitelisted user).
    let chatId: bigint | null;
    if (outputChannelId) {
      try {
        chatId = BigInt(outputChannelId);
      } catch {
        console.error(
          `[agent-jobs] Invalid Telegram chat ID "${outputChannelId}" for user ${userId} — output will not be sent.`,
        );
        return undefined;
      }
    } else {
      chatId = await resolveDefaultTelegramChat(account.id);
      if (chatId === null) {
        console.error(
          `[agent-jobs] Telegram output requested for user ${userId} but no configured chat exists (message the bot first or set a chat ID) — output will not be sent.`,
        );
        return undefined;
      }
    }

    return {
      send(content) {
        sendTelegramMessage(account.encryptedToken, chatId, content).catch((err) => {
          console.error(`[agent-jobs] Failed to send Telegram output to chat ${chatId}:`, err);
        });
      },
      typing() {
        sendTypingIndicator(account.encryptedToken, chatId);
      },
    };
  }

  if (!outputChannelId) {
    console.warn(
      `[agent-jobs] Output channel "${outputChannel}" is set without a target ID — output will not be routed.`,
    );
    return undefined;
  }

  console.warn(
    `[agent-jobs] Output channel "${outputChannel}" is not supported yet — output will not be routed.`,
  );
  return undefined;
}
