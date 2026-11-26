import { SessionManager } from "@earendil-works/pi-coding-agent";
import { get as getPooledSession, getPoolKey, getSessionDir } from "./agent-pool";

/**
 * Notes in a chat's Pi transcript.
 *
 * The agent's context comes from its own JSONL transcript, never from
 * `ChatMessage` rows. Anything the product did in a chat without a model turn
 * has to be appended here, or the agent's next message reads as if it had not
 * happened.
 */

/** What one note is, so it can be told apart from what the user and model said. */
export interface SessionNote {
  userId: string;
  sessionId: string;
  /** Custom-entry type, e.g. `render_note`. */
  type: string;
  text: string;
}

/** Append a note to the chat's transcript, pooled here or on disk. */
export async function appendSessionNote(note: SessionNote): Promise<void> {
  const pooled = getPooledSession(getPoolKey(note.userId, note.sessionId));

  if (pooled) {
    // The session's own queue defers a note from a running turn to its end. A
    // note written now could land between a tool call and its result.
    await pooled.session.sendCustomMessage(
      { customType: note.type, content: note.text, display: false },
      { triggerTurn: false },
    );
    return;
  }

  const sessionDir = getSessionDir(note.userId, note.sessionId);
  SessionManager.continueRecent(sessionDir, sessionDir).appendCustomMessageEntry(
    note.type,
    note.text,
    false,
  );
}
