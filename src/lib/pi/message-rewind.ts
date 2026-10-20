import type {
  AgentSession,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { claimPendingHistoryRewind, getPendingHistoryRewind } from "@/lib/redis";

/**
 * Rewind an agent session's transcript to a message whose DB row was edited.
 *
 * The DB is the source of truth for the conversation, but the Pi transcript is
 * append-only: `session.prompt()` always appends. After an edit, the transcript
 * still contains the old message and the replies the edit deleted, so simply
 * re-prompting sends the edited text as a NEW message following the deleted
 * conversation. the model sees both versions.
 *
 * Pi's own primitive for this is `navigateTree()` (the TUI's "edit an earlier
 * message" flow): pointing it at a user-message entry moves the leaf to that
 * entry's parent, so the next prompt replaces the message instead of appending
 * to it. Since pi v0.87 the SessionManager is canonical for the provider
 * context. every request is rebuilt from its projection. so moving the leaf
 * is the whole rewind; `navigateTree()` resyncs the agent's public state
 * itself. Never assign `session.agent.state.messages`: since v0.87 it does not
 * affect what future requests send.
 */

/** The edited message, located from both the DB and its pre-edit content. */
export interface RewindTarget {
  /** Position among the session's saved user messages (DB order). */
  userMessageIndex: number;
  /** The message's content before the edit. */
  previousContent: string;
}

/** Plain text of a transcript entry's user message ("" when it has none). */
function messageText(entry: SessionMessageEntry): string {
  const { content } = entry.message as { content?: unknown };
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text",
    )
    .map((block) => block.text ?? "")
    .join("");
}

function isUserMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === "message" && entry.message.role === "user";
}

/** The user messages on the transcript's active branch, in order. */
export function transcriptUserMessages(session: AgentSession): SessionMessageEntry[] {
  return session.sessionManager.getBranch().filter(isUserMessageEntry);
}

/**
 * Pick the transcript entry the edited message replaced.
 *
 * The DB's user messages and the transcript's user messages are written in the
 * same order, so the DB position is the primary signal. verified against the
 * pre-edit content. When they drift (a prompt that failed before the SDK
 * recorded it, prompt-template expansion), fall back to the closest text match.
 * Returns null when the entry cannot be identified: a wrong guess would delete
 * history, so the caller skips the rewind instead.
 */
export function findRewindEntry(
  entries: SessionMessageEntry[],
  target: RewindTarget,
): SessionMessageEntry | null {
  const { userMessageIndex, previousContent } = target;

  const aligned = entries[userMessageIndex];
  if (aligned && messageText(aligned) === previousContent) return aligned;

  let closest: SessionMessageEntry | null = null;
  let closestDistance = Infinity;
  entries.forEach((entry, index) => {
    if (messageText(entry) !== previousContent) return;
    const distance = Math.abs(index - userMessageIndex);
    if (distance < closestDistance) {
      closest = entry;
      closestDistance = distance;
    }
  });
  return closest;
}

/**
 * Move the transcript's leaf so the next prompt replaces `entry`.
 */
async function rewindLeafBefore(session: AgentSession, entry: SessionMessageEntry): Promise<void> {
  const { sessionManager } = session;

  if (sessionManager.getLeafId() !== entry.id) {
    await session.navigateTree(entry.id);
    return;
  }

  // Nothing was recorded after the entry, so it is still the leaf and
  // navigating to it would be a no-op.
  if (entry.parentId) {
    await session.navigateTree(entry.parentId);
  } else {
    // The first message has no parent entry to navigate to. reset the leaf
    // directly and resync the agent's state from the (now empty) projection.
    sessionManager.resetLeaf();
    session.refreshContext();
  }
}

/**
 * Rewind the session so the next prompt replaces the edited message.
 *
 * Returns false when the transcript holds no entry for it (e.g. it was never
 * prompted). there is nothing to rewind and the prompt proceeds normally.
 */
export async function rewindSessionToMessage(
  session: AgentSession,
  target: RewindTarget,
): Promise<boolean> {
  const entry = findRewindEntry(transcriptUserMessages(session), target);
  if (!entry) return false;
  await rewindLeafBefore(session, entry);
  return true;
}

/**
 * Rewind a transcript that ends with the very message about to be prompted.
 *
 * A run that dies mid-flight (process restart, crash, killed container) leaves
 * its prompt in the transcript but never a reply. The recovery path re-prompts
 * that message, and `session.prompt()` always appends. so without this the
 * model reads the same request twice and the transcript grows a duplicate turn.
 * Rewinding first makes the re-prompt replace the abandoned entry.
 *
 * The test is deliberately conservative: the transcript's newest user entry
 * must BE the leaf (nothing was recorded after it, so its run never replied)
 * and carry exactly this text. A prompt whose reply was recorded always has
 * entries after it, and a different message never matches. so a live
 * conversation is never rewritten on a guess.
 *
 * @param target.content - The stored content of the message about to be prompted.
 * @returns true when the transcript was rewound.
 */
export async function rewindDuplicatePrompt(
  session: AgentSession,
  target: { content: string },
): Promise<boolean> {
  const entries = transcriptUserMessages(session);
  const last = entries[entries.length - 1];
  if (!last || messageText(last) !== target.content) return false;
  if (session.sessionManager.getLeafId() !== last.id) return false;

  await rewindLeafBefore(session, last);
  return true;
}

/** What the prompt path did with a pending rewind request. */
export type RewindOutcome = "rewound" | "no-transcript-entry" | "nothing-pending";

/**
 * Apply the pending rewind for a message that is about to be prompted.
 *
 * The read is separated from the claim so a rewind can only ever be applied to
 * the message it was written for. consuming it while prompting an unrelated
 * one (a queued delivery, a stale-run recovery) would throw the edit away.
 * A failure is logged, never thrown: the prompt still has to go out.
 */
export async function applyPendingHistoryRewind(
  sessionId: string,
  session: AgentSession,
  messageId: string,
): Promise<RewindOutcome> {
  const pending = await getPendingHistoryRewind(sessionId);
  if (!pending || pending.messageId !== messageId) return "nothing-pending";
  await claimPendingHistoryRewind(sessionId);

  try {
    const rewound = await rewindSessionToMessage(session, {
      userMessageIndex: pending.userMessageIndex,
      previousContent: pending.previousContent,
    });
    return rewound ? "rewound" : "no-transcript-entry";
  } catch (err) {
    console.error(`Failed to rewind the transcript for edited message ${messageId}:`, err);
    return "no-transcript-entry";
  }
}
