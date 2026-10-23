import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { listTelegramChats } from "@/lib/telegram/chats";
import { getLinkByUserId } from "@/lib/telegram/links";
import { sendTelegramToUser } from "@/lib/telegram/notify";

/**
 * Name of the outreach tool, shared so a delivery channel can recognise that the
 * agent reached the user itself instead of the runner doing it.
 */
export const TELEGRAM_SEND_TOOL_NAME = "telegram_send";

/** Name of the tool that lists destinations, so the two read as a pair. */
export const TELEGRAM_CHATS_TOOL_NAME = "telegram_chats";

/** Confirmation of a delivered message: where it went, and how to name it. */
const telegramSendSchema = Type.Object({
  sent: Type.Boolean(),
  chatId: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
});

/** One destination: the user's private chat, or a group they added the bot to. */
const telegramChatSchema = Type.Object({
  chatId: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
  kind: Type.String(),
  memberCount: Type.Union([Type.Number(), Type.Null()]),
  enabled: Type.Boolean(),
  isPrivate: Type.Boolean(),
});

const telegramChatsSchema = Type.Object({
  chats: Type.Array(telegramChatSchema),
});

/**
 * Create Telegram tools with userId injection for user isolation.
 *
 * `telegram_send` is the agent's *outreach* primitive: it is the only way to
 * say something to the user once the conversation is over. Its recipient
 * defaults to the caller's own linked chat and can only be widened to a group
 * that same user added the bot to, so a message the model decided to send can
 * never reach another person.
 *
 * `telegram_chats` is the list that makes a group addressable. It is read live
 * rather than baked into a prompt: pooled sessions outlive a group's title.
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
        "conversation ends. By default it goes to the user's own chat. Pass a " +
        "`target` chat id from `telegram_chats` to post in a group the user added " +
        "the bot to. Write it as a complete, self-contained message they can act " +
        "on without this conversation, and keep it short. it interrupts them.",
      parameters: Type.Object({
        message: Type.String({
          description:
            "The message to send, in Markdown. Self-contained. the user may not " +
            "remember the context it came from.",
        }),
        target: Type.Optional(
          Type.String({
            description:
              "Chat id of a Telegram group to post in, from `telegram_chats`. Omit " +
              "to message the user privately.",
          }),
        ),
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
          target: params.target ?? null,
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
          text: `Sent to ${delivery.label ? `"${delivery.label}"` : "the user"} on Telegram. They will see it on their phone.`,
          details: { chatId: delivery.chatId, label: delivery.label },
        };
      },
    }),

    defineStructuredTool({
      name: TELEGRAM_CHATS_TOOL_NAME,
      label: "List Telegram Chats",
      description:
        "List the Telegram chats you can send to: the user's own chat and any " +
        "groups they added the bot to. A group's `chatId` is what `telegram_send` " +
        "takes as its `target`.",
      parameters: Type.Object({}),
      outputSchema: telegramChatsSchema,
      execute: async () => {
        const [link, groups] = await Promise.all([
          getLinkByUserId(userId),
          listTelegramChats(userId),
        ]);

        const value = {
          chats: [
            ...(link
              ? [
                  {
                    chatId: link.telegramChatId.toString(),
                    title: link.displayName,
                    kind: "private",
                    memberCount: null,
                    enabled: true,
                    isPrivate: true,
                  },
                ]
              : []),
            ...groups.map((group) => ({
              chatId: group.chatId.toString(),
              title: group.title,
              kind: group.kind,
              memberCount: group.memberCount,
              enabled: group.enabled,
              isPrivate: false,
            })),
          ],
        };

        if (value.chats.length === 0) {
          return {
            value,
            text: "This account has no Telegram chats yet. The user has to link their account and add the bot to a group first.",
          };
        }

        return { value, text: JSON.stringify(value, null, 2) };
      },
    }),
  ];
}
