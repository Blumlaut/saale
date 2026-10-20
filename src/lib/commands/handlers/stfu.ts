import {
  STFU_DURATION_MS,
  disableAutoApprove,
  enableAutoApprove,
  getAutoApproveExpiry,
} from "@/lib/pi/auto-approve";
import type { CommandHandler } from "../types";

/**
 * `/stfu`. auto-accept every tool approval for a time box.
 *
 * The flag is per user and lives in Redis, so it applies to web *and* Telegram
 * runs from the moment it is set.
 */
export const stfuHandler: CommandHandler = {
  prepare: async (ctx) => {
    const expiry = await getAutoApproveExpiry(ctx.userId);
    const active = expiry !== null && expiry > Date.now();

    return {
      title: "Tool approvals",
      description: active
        ? `STFU mode is on until ${formatTime(expiry)}. Tool approvals are auto-accepted.`
        : "Auto-accept every tool approval for 2 hours. Tools you disabled stay off.",
      options: [
        { value: "on", label: "Enable for 2 hours", current: !active },
        // "stop" is the value the old Telegram argument used. keep it so
        // `/stfu stop` keeps working for anyone who learned it.
        { value: "stop", label: "Turn off", current: active },
      ],
    };
  },

  run: async (ctx, value) => {
    if (value === "on") {
      const until = await enableAutoApprove(ctx.userId, STFU_DURATION_MS);
      return {
        message: `STFU mode ON until ${formatTime(until)}. tool approvals are auto-accepted.`,
        tone: "success",
      };
    }

    if (value === "stop") {
      await disableAutoApprove(ctx.userId);
      return { message: "STFU mode cancelled.", tone: "success" };
    }

    // Never change the approval posture on a value we don't recognise.
    return { message: `Unknown option for /stfu: ${value}`, tone: "error" };
  },
};

/** Local wall-clock time for an expiry timestamp. */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
