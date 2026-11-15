import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { get as getPooledSession, getPoolKey, getSessionDir } from "./agent-pool";

/**
 * A render a slash command made, noted in the chat's Pi transcript.
 *
 * The card lives in `ChatMessage`, which the agent never reads: its context comes
 * from its own JSONL transcript. `/image` and `/edit` render without a model
 * turn, so without a note the next message reads as if the picture had never
 * been made. The agent's own image tools need nothing here; their call and
 * result are in the transcript already.
 */

/** Custom-entry type, so a note is told apart from what the user and model said. */
export const RENDER_NOTE_TYPE = "render_note";

export interface RenderNote {
  /** The command that made the picture. */
  command: "image" | "edit";
  /** The sentence the card reads back: prompt, model, size and where it landed. */
  sentence: string;
  /** The pictures the render worked from, for an edit. */
  sources?: readonly string[] | undefined;
}

/** What the note says. It reads as the user reporting what they rendered. */
export function renderNoteText(note: RenderNote): string {
  const lines = [`[/${note.command}] ${note.sentence}`];
  if (note.sources?.length) {
    lines.push(`Worked from: ${note.sources.join(", ")}.`);
  }
  return lines.join("\n");
}

/** Append a render's note to the chat's transcript. */
export async function appendRenderNote(
  note: RenderNote & { userId: string; sessionId: string },
): Promise<void> {
  const text = renderNoteText(note);
  const pooled = getPooledSession(getPoolKey(note.userId, note.sessionId));

  if (pooled) {
    // The session's own queue defers a note from a running turn to its end. A
    // note written now could land between a tool call and its result.
    await pooled.session.sendCustomMessage(
      { customType: RENDER_NOTE_TYPE, content: text, display: false },
      { triggerTurn: false },
    );
    return;
  }

  const sessionDir = getSessionDir(note.userId, note.sessionId);
  appendNote(SessionManager.continueRecent(sessionDir, sessionDir), text);
}

/**
 * Note the chat's renders in a transcript that holds none yet.
 *
 * Pi writes its session file once a user or assistant message is in it, so a
 * first `/image` in an empty chat has nowhere to put its note. Its card is in
 * the DB, so the transcript starts with what that chat already rendered instead.
 */
export async function seedRenderNotes(input: {
  sessionId: string;
  sessionManager: SessionManager;
}): Promise<void> {
  if (input.sessionManager.getEntryCount() > 0) return;

  const messages = await prisma.chatMessage.findMany({
    where: { sessionId: input.sessionId, toolCalls: { contains: "_saaleImageMeta" } },
    orderBy: { createdAt: "asc" },
    select: { toolCalls: true },
  });
  for (const message of messages) {
    for (const note of notesInToolCalls(message.toolCalls)) {
      appendNote(input.sessionManager, renderNoteText(note));
    }
  }
}

function appendNote(manager: SessionManager, text: string): void {
  manager.appendCustomMessageEntry(RENDER_NOTE_TYPE, text, false);
}

/** The renders a message's stored tool calls recorded, in the order they ran. */
function notesInToolCalls(toolCallsJson: string | null): RenderNote[] {
  if (!toolCallsJson) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCallsJson);
  } catch (err) {
    console.error("Failed to parse a message's tool calls for its render notes:", err);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const notes: RenderNote[] = [];
  for (const call of parsed as Array<{
    name?: unknown;
    args?: unknown;
    result?: unknown;
  }>) {
    const result = typeof call.result === "string" ? call.result : "";
    if (!result.includes("_saaleImageMeta")) continue;

    // The stored result opens with the sentence the card shows.
    const sentence = result.split("\n")[0]?.trim();
    if (!sentence) continue;

    notes.push({
      command: call.name === "edit_image" ? "edit" : "image",
      sentence,
      ...(sourcesOf(call.args) ?? {}),
    });
  }
  return notes;
}

/** The `images` argument an edit was given, when it recorded one. */
function sourcesOf(args: unknown): { sources: string[] } | undefined {
  if (!args || typeof args !== "object") return undefined;
  const images = (args as { images?: unknown }).images;
  if (!Array.isArray(images)) return undefined;

  const sources = images.filter((path): path is string => typeof path === "string");
  return sources.length > 0 ? { sources } : undefined;
}
