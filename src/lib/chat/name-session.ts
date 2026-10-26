/**
 * Naming a chat from the prompt that opened it.
 *
 * Every path that stores a user prompt writes these fields in the same update,
 * so the chat is named the moment the prompt reaches the server: no client
 * connection, no model, no waiting for the title job.
 */

import { deriveChatTitle } from "@/lib/chat/derive-title";

/** Matches `ChatSession.title`. */
const MAX_TITLE_LENGTH = 50;

export interface PromptTitleFields {
  title: string;
  /** Set once the prompt named the chat; an unnamed one stays on "default". */
  titleSource?: "auto";
}

/** The prompt quoted as a title, for one the titler cannot read. */
function quotePrompt(promptText: string): string {
  const cut = promptText.slice(0, MAX_TITLE_LENGTH - 3).trimEnd();
  return promptText.length > cut.length ? `${cut}...` : cut;
}

/**
 * The title fields to write with a new message, or null when the chat already
 * has a name (renamed, named on creation, or titled by the job).
 *
 * A prompt that says nothing ("hi", a file on its own) keeps the chat open, so
 * the next message gets the try.
 */
export function promptTitleFields(
  titleSource: string,
  promptText: string,
): PromptTitleFields | null {
  if (titleSource !== "default") return null;

  const derived = deriveChatTitle(promptText);
  if (derived) return { title: derived, titleSource: "auto" };

  const quoted = quotePrompt(promptText);
  return quoted ? { title: quoted } : null;
}
