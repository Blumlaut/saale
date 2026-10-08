/**
 * Delivering a watcher's fire to the agent.
 *
 * A tick is cheap and answers "did anything change?". When the answer is yes the
 * work needs a model, and this is where the script's return value becomes the
 * agent's problem:
 *
 * - bound to a conversation → posted into that chat as a message and answered
 *   there, so the finding lands in the thread the user asked from, with the
 *   thread's own context and tools;
 * - unbound → a standalone run under a per-user system definition, for a watcher
 *   created outside any conversation.
 *
 * Both are the existing turn paths (`respondInChat`, `triggerAgentRun`) rather
 * than a new one — a wake is a normal agent run that happens to have been
 * started by a script.
 */

import { prisma } from "@/lib/db";
import { respondInChat } from "@/lib/chat/respond-in-chat";
import { triggerAgentRun } from "@/lib/agent-jobs/run";

/** Name of the per-user definition standalone watcher wakes run under. */
const WATCHER_AGENT_NAME = "Watchers";

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

/**
 * The definition standalone watcher wakes run under.
 *
 * One per user, system-managed so it cannot be edited or run by hand — it exists
 * to own watcher runs and their transcripts, mirroring the Telegram agent.
 * Adopted rather than duplicated if a definition with this name already exists,
 * since `name` is unique per user.
 */
export async function ensureWatcherAgentDefinition(userId: string): Promise<{ id: string }> {
  const existing = await prisma.agentDefinition.findFirst({
    where: { userId, name: WATCHER_AGENT_NAME },
    select: { id: true, systemManaged: true },
  });

  if (existing) {
    if (!existing.systemManaged) {
      await prisma.agentDefinition.update({
        where: { id: existing.id },
        data: { systemManaged: true },
      });
    }
    return { id: existing.id };
  }

  const created = await prisma.agentDefinition.create({
    data: {
      userId,
      name: WATCHER_AGENT_NAME,
      description: "Runs started by script watchers",
      prompt: "",
      systemManaged: true,
      enabled: true,
      toolConfig: {
        email: true,
        calendar: true,
        chatSearch: true,
        web: true,
        memory: true,
        tasks: true,
        telegram: true,
        terminal: true,
      },
    },
    select: { id: true },
  });

  return { id: created.id };
}

/**
 * Hand a fired watcher to the agent.
 *
 * A chat that is already generating is refused rather than queued: the watcher
 * will fire again on the next tick (its `lastFiredAt` is only written on a
 * delivered wake), which is simpler than racing a run that is mid-transcript —
 * and a queued message would be answered against a conversation that has moved
 * on since.
 */
export async function wakeAgent(options: {
  userId: string;
  name: string;
  wakePrompt: string;
  sessionId: string | null;
  /** Model for a standalone wake; a chat-bound wake uses its conversation's model. */
  modelId: string | null;
  value: unknown;
}): Promise<void> {
  const message = buildWakeMessage({
    name: options.name,
    wakePrompt: options.wakePrompt,
    value: options.value,
  });

  if (options.sessionId) {
    // `respondInChat` refuses a busy or missing chat with a thrown error, which
    // the caller records on the tick.
    await respondInChat({
      userId: options.userId,
      sessionId: options.sessionId,
      message,
    });
    return;
  }

  const definition = await ensureWatcherAgentDefinition(options.userId);
  await triggerAgentRun({
    definitionId: definition.id,
    userId: options.userId,
    promptOverride: message,
    ...(options.modelId ? { modelId: options.modelId } : {}),
  });
}
