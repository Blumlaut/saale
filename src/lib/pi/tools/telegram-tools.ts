import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { sendTelegramToUser } from "@/lib/telegram/notify";

/**
 * Name of the outreach tool, shared so a delivery channel can recognise that the
 * agent reached the user itself instead of the runner doing it.
 */
export const TELEGRAM_SEND_TOOL_NAME = "telegram_send";

/** Confirmation of a delivered message: where it went, and how to name it. */
const telegramSendSchema = Type.Object({
  sent: Type.Boolean(),
  chatId: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
});

/**
 * Create Telegram tools with userId injection for user isolation.
 *
 * The single tool here is the agent's *outreach* primitive: it is the only way
 * to say something to the user once the conversation is over. It deliberately
 * takes no recipient. delivery always goes to the caller's own linked
 * Telegram chat (see `sendTelegramToUser`), so a message the model decided to
 * send can never reach another person.
 *
 * `sessionId` names the chat that produced the message. it is recorded with the
 * delivery so a reply in Telegram continues this conversation.
 */
export function createTelegramTools(userId: string, sessionId: string): ToolDefinition[] {
  return [
    defineStructuredTool({
      name: TELEGRAM_SEND_TOOL_NAME,
      label: "Send Telegram Message",
      description:
        "Message the user on Telegram. their phone, outside this conversation. " +
        "Use it for reminders they asked for, appointments, or anything that must " +
        "reach them later; it is the only way to contact them after the " +
        "conversation ends. The recipient is always the user's own chat and cannot " +
        "be chosen. Write it as a complete, self-contained message they can act on " +
        "without this conversation, and keep it short. it interrupts them.",
      parameters: Type.Object({
        message: Type.String({
          description:
            "The message to send, in Markdown. Self-contained. the user may not " +
            "remember the context it came from.",
        }),
      }),
      outputSchema: telegramSendSchema,
      execute: async (_toolCallId, params) => {
        const message = params.message.trim();
        if (!message) {
          throw new Error("The message is empty. nothing was sent.");
        }

        const delivery = await sendTelegramToUser({
          userId,
          content: message,
          sourceSessionId: sessionId,
        });

        if (!delivery.ok) {
          // Throw rather than flag a result: the agent loop turns a throw into a
          // failed tool call carrying the reason, so the model can tell the user
          // why nothing arrived instead of assuming it was delivered.
          throw new Error(`Telegram message not delivered: ${delivery.error}`);
        }

        return {
          value: {
            sent: true,
            ...(delivery.chatId ? { chatId: delivery.chatId } : {}),
            ...(delivery.label ? { label: delivery.label } : {}),
          },
          text: `Sent to the user on Telegram${
            delivery.label ? ` (${delivery.label})` : ""
          }. They will see it on their phone.`,
          details: { chatId: delivery.chatId, label: delivery.label },
        };
      },
    }),
  ];
}
