import { prisma } from "@/lib/db";
import { sendTelegramMessage, sendTypingIndicator } from "@/lib/telegram/client";
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

  if (!outputChannel || !outputChannelId) {
    return undefined;
  }

  if (outputChannel === "telegram") {
    const account = await prisma.telegramAccount.findUnique({
      where: { userId },
      select: { encryptedToken: true },
    });

    if (!account) {
      console.error(
        `[agent-jobs] Telegram output requested for user ${userId} but no Telegram account is configured — output will not be sent.`,
      );
      return undefined;
    }

    let chatId: bigint;
    try {
      chatId = BigInt(outputChannelId);
    } catch {
      console.error(
        `[agent-jobs] Invalid Telegram chat ID "${outputChannelId}" for user ${userId} — output will not be sent.`,
      );
      return undefined;
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

  console.warn(
    `[agent-jobs] Output channel "${outputChannel}" is not supported yet — output will not be routed.`,
  );
  return undefined;
}
