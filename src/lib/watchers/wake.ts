/**
 * Delivering an automation's fire.
 *
 * A tick is cheap and answers "did anything change?". When the answer is yes,
 * `deliver` says where the finding goes:
 *
 * - `chat` → posted into the chosen conversation and answered there, so it lands
 *   in the thread the user asked from, with the thread's own context and tools;
 * - `none` → the agent runs on its own and nothing is written anywhere. What the
 *   user hears about comes from the tools it calls (`standalone.ts`);
 * - `coder` → a coder chat in the automation's project, in a worktree of its own
 *   (`coder/dispatch.ts`);
 * - `silent` → nowhere. The script told the user itself, and the tick records
 *   what it returned. A silent fire is settled in `tick.ts` and never reaches
 *   here, because a wake that would run an agent is the whole thing it declines.
 */

import { respondInChat } from "@/lib/chat/respond-in-chat";
import { dispatchWatcherRun } from "@/lib/coder/dispatch";
import { runStandaloneWake } from "./standalone";

/** What a fire produced that is worth telling the tick log about. */
export interface WakeDelivery {
  /** The chat the fire was delivered into, when there is one. */
  sessionId: string | null;
  /** What the agent said, when there was no chat for it to say it in. */
  answer?: string | null;
  /** The tools a chat-less run called. how it delivered, if it did. */
  toolNames?: string[];
  /** Tokens the wake spent, for a run with no chat to account for it. */
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

/** How the agent is told what fired. */
export function buildWakeMessage(options: {
  name: string;
  wakePrompt: string;
  /** The script's value. Absent when the automation has no script. */
  value?: unknown;
  /** Whether a script produced the value. */
  gated: boolean;
}): string {
  const lines = [`Automation "${options.name}" fired.`, "", options.wakePrompt.trim()];

  if (!options.gated) return lines.join("\n");

  let payload: string;
  try {
    payload = JSON.stringify(options.value, null, 2) ?? String(options.value);
  } catch (err) {
    // A value the sandbox returned is JSON by construction; this is a guard
    // against a future change to the runner, not an expected path.
    console.error("Automation value could not be serialized:", err);
    payload = String(options.value);
  }

  return [...lines, "", "The script returned:", "```json", payload, "```"].join("\n");
}

/** The automation fields delivery reads. */
export interface WakeTarget {
  id: string;
  userId: string;
  name: string;
  /** "chat" | "none" | "silent" | "coder". */
  deliver: string;
  sessionId: string | null;
  /** The chat the automation was created from. what its tools act as. */
  originSessionId: string | null;
  projectId: string | null;
  worktreeMode: string;
  stickySessionId: string | null;
  wakePrompt: string;
  /** Model for a fire with no chat; a `chat` fire uses the chat's own. */
  modelId: string | null;
  thinkingLevel: string;
}

/**
 * Hand a fired automation to the agent.
 *
 * A chat that is already generating is refused rather than queued: the
 * automation will fire again on the next tick (its `lastFiredAt` is only written
 * on a delivered wake), which is simpler than racing a run that is mid-transcript
 * and a queued message would be answered against a conversation that has moved
 * on since. A coder fire behaves the same way in `sticky` mode, where the fire
 * shares a chat with the one before it.
 *
 * @throws when the delivery could not happen, so the caller records a blocked
 * tick and leaves the script's ledger where it was.
 */
export async function deliverWake(options: {
  watcher: WakeTarget;
  value: unknown;
  /** Whether a script produced `value`; an automation without one fires bare. */
  gated: boolean;
}): Promise<WakeDelivery> {
  const { watcher } = options;

  if (watcher.deliver === "silent") return { sessionId: null };

  const message = buildWakeMessage({
    name: watcher.name,
    wakePrompt: watcher.wakePrompt,
    value: options.value,
    gated: options.gated,
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

  if (watcher.deliver === "none") {
    const run = await runStandaloneWake({
      userId: watcher.userId,
      watcher: {
        id: watcher.id,
        modelId: watcher.modelId,
        thinkingLevel: watcher.thinkingLevel,
      },
      scopeId: watcher.sessionId ?? watcher.originSessionId ?? `watcher:${watcher.id}`,
      message,
    });
    return {
      sessionId: null,
      answer: run.answer,
      toolNames: run.toolNames,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cost: run.cost,
    };
  }

  if (!watcher.sessionId) {
    throw new Error(
      "This automation has no conversation to report into. Pick one, run it on its own, dispatch into a project, or deliver from the script.",
    );
  }

  // `respondInChat` refuses a busy or missing chat with a thrown error, which
  // the caller records on the tick.
  const reply = await respondInChat({
    userId: watcher.userId,
    sessionId: watcher.sessionId,
    message,
  });
  return { sessionId: watcher.sessionId, answer: reply.reply || null };
}
