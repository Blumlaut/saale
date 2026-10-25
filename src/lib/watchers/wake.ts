/**
 * Delivering a watcher's fire.
 *
 * A tick is cheap and answers "did anything change?". When the answer is yes,
 * `deliver` says where the finding goes:
 *
 * - `chat` → posted into the chosen conversation and answered there, so it lands
 *   in the thread the user asked from, with the thread's own context and tools;
 * - `coder` → a coder chat in the watcher's project, in a worktree of its own
 *   (`coder/dispatch.ts`);
 * - `silent` → nowhere. The script told the user itself, and the tick records
 *   what it returned. A silent fire is settled in `tick.ts` and never reaches
 *   here, because a wake that would run an agent is the whole thing it declines.
 */

import { respondInChat } from "@/lib/chat/respond-in-chat";
import { dispatchWatcherRun } from "@/lib/coder/dispatch";

/** What a fire produced that is worth telling the tick log about. */
export interface WakeDelivery {
  /** The chat the fire was delivered into, when there is one. */
  sessionId: string | null;
}

/** How the agent is told what fired. */
export function buildWakeMessage(options: {
  name: string;
  wakePrompt: string;
  value: unknown;
}): string {
  let payload: string;
  try {
    payload = JSON.stringify(options.value, null, 2) ?? String(options.value);
  } catch (err) {
    // A value the sandbox returned is JSON by construction; this is a guard
    // against a future change to the runner, not an expected path.
    console.error("Watcher value could not be serialized:", err);
    payload = String(options.value);
  }

  return [
    `Watcher "${options.name}" fired.`,
    "",
    options.wakePrompt.trim(),
    "",
    "The script returned:",
    "```json",
    payload,
    "```",
  ].join("\n");
}

/** The watcher fields delivery reads. */
export interface WakeTarget {
  id: string;
  userId: string;
  name: string;
  /** "chat" | "silent" | "coder". */
  deliver: string;
  sessionId: string | null;
  projectId: string | null;
  worktreeMode: string;
  stickySessionId: string | null;
  wakePrompt: string;
  /** Model for a fire that opens its own chat; a `chat` fire uses the chat's. */
  modelId: string | null;
}

/**
 * Hand a fired watcher to the agent.
 *
 * A chat that is already generating is refused rather than queued: the watcher
 * will fire again on the next tick (its `lastFiredAt` is only written on a
 * delivered wake), which is simpler than racing a run that is mid-transcript and
 * a queued message would be answered against a conversation that has moved on
 * since. A coder fire behaves the same way in `sticky` mode, where the fire
 * shares a chat with the one before it.
 *
 * @throws when the delivery could not happen, so the caller records a blocked
 * tick and leaves the script's ledger where it was.
 */
export async function deliverWake(options: {
  watcher: WakeTarget;
  value: unknown;
}): Promise<WakeDelivery> {
  const { watcher } = options;

  if (watcher.deliver === "silent") return { sessionId: null };

  const message = buildWakeMessage({
    name: watcher.name,
    wakePrompt: watcher.wakePrompt,
    value: options.value,
  });

  if (watcher.deliver === "coder") {
    const dispatched = await dispatchWatcherRun({
      userId: watcher.userId,
      watcher,
      modelId: watcher.modelId,
      message,
      value: options.value,
    });
    return { sessionId: dispatched.sessionId };
  }

  if (!watcher.sessionId) {
    throw new Error(
      "This watcher has no conversation to report into. Pick one, dispatch into a project, or deliver from the script.",
    );
  }

  // `respondInChat` refuses a busy or missing chat with a thrown error, which
  // the caller records on the tick.
  await respondInChat({
    userId: watcher.userId,
    sessionId: watcher.sessionId,
    message,
  });
  return { sessionId: watcher.sessionId };
}
