import {
  STFU_DURATION_MS,
  autoApproveState,
  disableAutoApprove,
  enableAutoApprove,
  getAutoApproveStatus,
} from "@/lib/pi/auto-approve";
import type { CommandHandler } from "../types";

/**
 * `/stfu` (also `/yolo`). auto-accept every tool approval.
 *
 * The flag is per user and lives in Redis, so it applies to web *and* Telegram
 * runs from the moment it is set. It can be a two-hour window or permanent.
 */
export const stfuHandler: CommandHandler = {
  prepare: async (ctx) => {
    const state = autoApproveState(await getAutoApproveStatus(ctx.userId));

    return {
      title: "Tool approvals",
      description:
        state.kind === "window"
          ? `STFU mode is on until ${formatTime(state.until)}. Tool approvals are auto-accepted.`
          : state.kind === "permanent"
            ? "STFU mode is on until you turn it off. Tool approvals are auto-accepted."
            : "Auto-accept every tool approval for 2 hours, permanently, or not at all. Tools you disabled stay off.",
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
    if (value === "on") {
      const until = await enableAutoApprove(ctx.userId, STFU_DURATION_MS);
      return { message: enabledMessage(until), tone: "success" };
    }

    if (value === "permanent") {
      const until = await enableAutoApprove(ctx.userId, null);
      return { message: enabledMessage(until), tone: "success" };
    }

    if (value === "stop") {
      await disableAutoApprove(ctx.userId);
      return { message: "STFU mode cancelled.", tone: "success" };
    }

    // Never change the approval posture on a value we don't recognise.
    return { message: `Unknown option for /stfu: ${value}`, tone: "error" };
  },
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
