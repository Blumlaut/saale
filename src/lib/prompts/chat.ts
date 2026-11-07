/**
 * The prompts a chat offers, and the send path's expansion.
 *
 * One entry point per question: what to list, and what a `/name args` message
 * becomes. The web messages route and the Telegram run both call the expansion,
 * so a prompt behaves the same wherever it is typed.
 */

import { getCommandMeta } from "@/lib/commands/catalog";
import { parseCommand } from "@/lib/commands/parse";
import { prisma } from "@/lib/db";
import { mergeOwnedRows } from "@/lib/shared-resources";
import { chatPromptDirectory, readProjectPrompts, type PromptChat } from "./project";
import {
  expandPrompt,
  mergePromptEntries,
  promptPickerItems,
  scopedPromptEntries,
  type PromptEntry,
  type PromptPickerItem,
} from "./resolve";
import { INSTANCE_PROMPTS, listPrompts, userPrompts } from "./store";

export type { PromptChat } from "./project";
export type { PromptEntry, PromptMatch, PromptPickerItem } from "./resolve";

/** Every prompt offered in a chat: the user's own, then the instance's, then the repo's. */
export async function promptsForChat(
  userId: string,
  chatSession: PromptChat,
): Promise<PromptEntry[]> {
  const [own, shared, cwd] = await Promise.all([
    listPrompts(userPrompts(userId)),
    listPrompts(INSTANCE_PROMPTS),
    chatPromptDirectory(userId, chatSession),
  ]);
  const project = await readProjectPrompts(cwd);
  return mergePromptEntries(
    scopedPromptEntries(mergeOwnedRows({ own, shared }), chatSession.projectId !== null),
    project,
  );
}

/** What the composer lists for a chat. */
export async function promptPickerItemsForChat(
  userId: string,
  chatSession: PromptChat,
): Promise<PromptPickerItem[]> {
  return promptPickerItems(await promptsForChat(userId, chatSession));
}

/**
 * The message to store and send: a `/name args` that names one of the chat's
 * prompts becomes its content, and anything else is returned untouched.
 */
export async function expandPromptInChat(options: {
  userId: string;
  sessionId: string;
  text: string;
}): Promise<string> {
  const parsed = parseCommand(options.text);
  if (!parsed || getCommandMeta(parsed.name)) return options.text;

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: options.sessionId, userId: options.userId },
    select: { id: true, projectId: true },
  });
  if (!chatSession) return options.text;

  const match = expandPrompt(options.text, await promptsForChat(options.userId, chatSession));
  return match ? match.content : options.text;
}
