/**
 * Picking up a turn a restart cut off, from the transcript's side.
 *
 * A run that dies mid-flight leaves the Pi transcript somewhere in the middle:
 * the user's message, then whichever turns the model got through, possibly with
 * a tool call whose result never arrived. The DB only ever sees finished turns
 * (its rows are written at `turn_end`/`agent_end`), so the transcript is the one
 * place that knows how far the work got, and carrying on from it picks the turn
 * up where it stopped.
 *
 * What can be carried on from follows from the last entry the model sees (state
 * entries the session appends, like its model, are not part of that):
 *
 * - the run's user message: nothing ran. The prompt is already there, continue.
 * - a finished turn, a tool result or a custom note: the model reads its own
 *   results and goes on.
 * - an assistant turn whose calls never returned: there is no result to read,
 *   and a provider rejects a context whose last tool call has none. The call is
 *   answered here instead, saying the instance stopped, so the model can check
 *   the state before repeating anything.
 * - an assistant turn with no calls: the model had nothing left to ask for.
 *   Following it with a new message is what a provider rejects, so the turn is
 *   abandoned and the request asked again.
 *
 * Anything else. a later user message on the branch, or a prompt the transcript
 * never received. is not this message's turn to resume, and the caller falls
 * back to prompting it.
 */

import type {
  AgentSession,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { rewindLeafBefore } from "./message-rewind";

/** What the transcript says about resuming a message's interrupted run. */
export type InterruptedTurnPlan =
  /** The prompt is in the transcript: continue the turn in place. */
  | { kind: "continue"; orphanedCalls: OrphanedCall[] }
  /** The prompt is in the transcript, but its last turn cannot be continued. */
  | { kind: "restart"; entry: SessionMessageEntry }
  /** The transcript is not this message's to resume: prompt it, as usual. */
  | { kind: "prompt" };

/** A call the model made that never came back. */
export interface OrphanedCall {
  id: string;
  name: string;
}

/**
 * What the model reads where a call's result would be.
 *
 * It knows the call ran, not what it did: the instance went down between the
 * two. Saying so is what lets the model check the state instead of repeating a
 * command that may already have landed.
 */
export const INTERRUPTED_TOOL_RESULT =
  "The Saale instance restarted before this call returned, so its outcome is unknown. " +
  "Check the current state before running it again.";

/**
 * What the model reads when the turn is picked back up.
 *
 * A Pi custom message: context the model sees, not a message in the chat. The
 * user never wrote it and must not read as if they had.
 */
export const INTERRUPTED_TURN_NOTE =
  "The Saale instance restarted while this turn was running, and it was picked back up here. " +
  "Continue the user's request from where it stopped. A result missing above means the instance " +
  "stopped before that call returned, so check the current state before repeating anything that " +
  "changes something. Do not start the request over.";

/** The custom message type Saale uses for that note. */
export const INTERRUPTED_TURN_CUSTOM_TYPE = "saale:interrupted-turn";

/** Plain text of a transcript entry's message ("" when it has none). */
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

/**
 * Entries that put something in front of the model.
 *
 * A transcript usually ends with a state entry. the model and thinking level a
 * session was built with are appended as entries of their own. so the leaf says
 * nothing about what the model last saw: only the last entry of these kinds does.
 */
function isContextEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "message" ||
    entry.type === "custom_message" ||
    entry.type === "compaction" ||
    entry.type === "branch_summary"
  );
}

/** The calls the branch made, and the ones that came back. */
function callsOf(entries: SessionEntry[]): { calls: OrphanedCall[]; answered: Set<string> } {
  const calls: OrphanedCall[] = [];
  const answered = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block !== "object" || block === null) continue;
        const call = block as { type?: unknown; id?: unknown; name?: unknown };
        if (call.type !== "toolCall" || typeof call.id !== "string") continue;
        calls.push({ id: call.id, name: typeof call.name === "string" ? call.name : "tool" });
      }
    }
    if (message.role === "toolResult") {
      const { toolCallId } = message as { toolCallId?: unknown };
      if (typeof toolCallId === "string") answered.add(toolCallId);
    }
  }

  return { calls, answered };
}

function orphanedCallsOf(entries: SessionEntry[]): OrphanedCall[] {
  const { calls, answered } = callsOf(entries);
  return calls.filter((call) => !answered.has(call.id));
}

/**
 * The calls on the active branch that never got a result.
 *
 * A prompt appends after the branch's last entry, so an orphaned call left by a
 * dead run has to be answered first whichever message is about to be sent:
 * every provider rejects a request that answers a call with a user message.
 */
export function orphanedCallsOnBranch(session: AgentSession): OrphanedCall[] {
  return orphanedCallsOf(session.sessionManager.getBranch());
}

function toolCallIdsOf(entry: SessionMessageEntry): string[] {
  const { content } = entry.message as { content?: unknown };
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const call = block as { type?: unknown; id?: unknown };
    return call.type === "toolCall" && typeof call.id === "string" ? [call.id] : [];
  });
}

/**
 * Read the transcript to see how the run of `target` can be picked up.
 *
 * Only ever continues a branch that ends in the run's own last turn. anything
 * it cannot place goes back to the caller as a plain prompt.
 */
export function planInterruptedTurn(
  session: AgentSession,
  target: { content: string },
): InterruptedTurnPlan {
  const branch = session.sessionManager.getBranch();

  let userIndex = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (!isUserMessageEntry(entry)) continue;
    userIndex = index;
    break;
  }
  // The prompt never reached the transcript, or was edited since: there is no
  // turn to pick up, only a message to send.
  if (userIndex < 0 || messageText(branch[userIndex] as SessionMessageEntry) !== target.content) {
    return { kind: "prompt" };
  }

  const entry = branch[userIndex] as SessionMessageEntry;
  const tail = branch.slice(userIndex + 1);
  // A later user message means a newer turn owns the conversation, so this run
  // is not the branch's last word any more.
  if (tail.some(isUserMessageEntry)) return { kind: "prompt" };

  // Nothing ran yet: the prompt is in the transcript and the turn still has to
  // happen.
  const context = tail.filter(isContextEntry);
  if (context.length === 0) return { kind: "continue", orphanedCalls: [] };

  const last = context[context.length - 1]!;
  // A compaction summary or one of these notes leaves the context on something
  // the model continues from.
  if (last.type !== "message") {
    return { kind: "continue", orphanedCalls: orphanedCallsOf(tail) };
  }
  // A tool result is the call's answer, so there is nothing to repair.
  if (last.message.role !== "assistant") {
    return { kind: "continue", orphanedCalls: orphanedCallsOf(tail) };
  }

  // The model's own turn ended the branch. One that asked for nothing was its
  // last word, and a new message may not follow it.
  if (toolCallIdsOf(last).length === 0) return { kind: "restart", entry };

  return { kind: "continue", orphanedCalls: orphanedCallsOf(tail) };
}

/**
 * Answer the calls the restart orphaned, so the model can read why it has no
 * result and the next request is one every provider accepts.
 */
export function answerOrphanedCalls(session: AgentSession, calls: OrphanedCall[]): void {
  if (calls.length === 0) return;

  for (const call of calls) {
    session.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
      isError: true,
      timestamp: Date.now(),
    });
  }
  // The SessionManager is canonical for the provider context, so the agent's
  // public state is resynced from it rather than written to directly.
  session.refreshContext();
}

/**
 * Make the transcript ready for the plan's run, and say whether that run
 * continues the turn or asks the message again.
 *
 * @returns `true` when the run must continue the turn in place, `false` when it
 * is a fresh prompt of the message.
 */
export async function applyInterruptedTurn(
  session: AgentSession,
  plan: InterruptedTurnPlan,
): Promise<boolean> {
  if (plan.kind === "continue") {
    answerOrphanedCalls(session, plan.orphanedCalls);
    return true;
  }
  if (plan.kind === "restart") {
    await rewindLeafBefore(session, plan.entry);
  }
  return false;
}

/**
 * Pick the interrupted turn back up where it stopped.
 *
 * Resolves once the run has settled, like `session.prompt()`.
 */
export async function continueInterruptedTurn(session: AgentSession): Promise<void> {
  await session.sendCustomMessage(
    {
      customType: INTERRUPTED_TURN_CUSTOM_TYPE,
      content: INTERRUPTED_TURN_NOTE,
      display: false,
    },
    { triggerTurn: true },
  );
}
