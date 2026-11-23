import {
  STFU_DURATION_MS,
  autoApproveState,
  disableAutoApprove,
  enableAutoApprove,
  getAutoApproveStatus,
} from "@/lib/pi/auto-approve";
import type { CommandHandler } from "../types";

/**
 * `/stfu` (also `/yolo`). auto-accept every tool approval in this chat.
 *
 * The flag is per chat and lives in Redis, so it applies to web and Telegram
 * runs of the conversation it was set in, and never to another one. It can be
 * a two-hour window or permanent.
 */
export const stfuHandler: CommandHandler = {
  prepare: async (ctx) => {
    const sessionId = ctx.sessionId;
    if (!sessionId) return { ...noChatPrompt, options: [] };

    const state = autoApproveState(await getAutoApproveStatus(ctx.userId, sessionId));

    return {
      title: noChatPrompt.title,
      description:
        state.kind === "window"
          ? `STFU mode is on in this chat until ${formatTime(state.until)}. Tool approvals are auto-accepted.`
          : state.kind === "permanent"
            ? "STFU mode is on in this chat until you turn it off. Tool approvals are auto-accepted."
            : "Auto-accept every tool approval in this chat for 2 hours, permanently, or not at all. Tools you disabled stay off.",
      options: [
        { value: "on", label: "Enable for 2 hours", current: state.kind === "off" },
        {
          value: "permanent",
          label: "Leave on until turned off",
          current: state.kind === "permanent",
        },
        // "stop" is the value the old Telegram argument used. keep it so
        // `/stfu stop` keeps working for anyone who learned it.
        { value: "stop", label: "Turn off", current: state.kind === "window" },
      ],
    };
  },

  run: async (ctx, value) => {
    const sessionId = ctx.sessionId;
    if (!sessionId) return { message: noChatPrompt.description, tone: "info" };

    if (value === "on") {
      const until = await enableAutoApprove(ctx.userId, sessionId, STFU_DURATION_MS);
      return { message: enabledMessage(until), tone: "success" };
    }

    if (value === "permanent") {
      const until = await enableAutoApprove(ctx.userId, sessionId, null);
      return { message: enabledMessage(until), tone: "success" };
    }

    if (value === "stop") {
      await disableAutoApprove(ctx.userId, sessionId);
      return { message: "STFU mode cancelled.", tone: "success" };
    }

    // Never change the approval posture on a value we don't recognise.
    return { message: `Unknown option for /stfu: ${value}`, tone: "error" };
  },
};

/** A command sent where there is no chat yet has nothing to switch on. */
const noChatPrompt = {
  title: "Tool approvals",
  description: "This message doesn't belong to a chat yet, and auto-accept applies to one chat.",
};

/** Confirmation for a mode that was just switched on. */
function enabledMessage(until: number | null): string {
  return until === null
    ? "STFU mode ON permanently. tool approvals are auto-accepted until you turn it off."
    : `STFU mode ON until ${formatTime(until)}. tool approvals are auto-accepted.`;
}

/** Local wall-clock time for an expiry timestamp. */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
