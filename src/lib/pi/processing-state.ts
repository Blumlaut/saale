import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Clear the processingSince flag on a chat session.
 *
 * Centralized so all callers (agent_end, compaction, errors, stop) use the same
 * path — prevents bugs where one caller forgets to clear the flag.
 */
export async function clearProcessingSince(sessionId: string): Promise<void> {
  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { processingSince: null },
  });
}

/**
 * Mark a chat session as processing (set processingSince to now).
 *
 * Centralized so all callers use the same path.
 */
export async function startProcessingSince(sessionId: string): Promise<void> {
  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { processingSince: new Date() },
  });
}

/**
 * Check if a session's processingSince is stale (older than STALE_THRESHOLD_MS).
 * Returns true if the session should be force-cleared.
 */
export function isProcessingStale(processingSince: Date | null): boolean {
  if (!processingSince) return false;
  return Date.now() - processingSince.getTime() > STALE_THRESHOLD_MS;
}

/**
 * Force-clear all sessions with stale processingSince flags.
 *
 * Runs as a safety net — if the server crashes, the stream handler throws,
 * or any other path fails to clear processingSince, this catches it.
 *
 * Returns the number of sessions that were cleared.
 */
export async function clearStaleProcessingStates(): Promise<number> {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  const staleSessions = await prisma.chatSession.findMany({
    where: {
      processingSince: {
        not: null,
        lte: staleThreshold,
      },
    },
    select: { id: true, processingSince: true },
  });

  if (staleSessions.length === 0) return 0;

  // eslint-disable-next-line no-console
  console.log(`[processing-state] Clearing ${staleSessions.length} stale processingSince flags`);

  await prisma.chatSession.updateMany({
    where: {
      id: { in: staleSessions.map((s) => s.id) },
      processingSince: { not: null },
    },
    data: { processingSince: null },
  });

  // Also clear any stale active tool state
  await prisma.chatSession.updateMany({
    where: {
      id: { in: staleSessions.map((s) => s.id) },
      activeToolName: { not: null },
    },
    data: {
      activeToolCallId: null,
      activeToolName: null,
      activeToolArgs: Prisma.JsonNull,
      activeToolStartedAt: null,
    },
  });

  return staleSessions.length;
}

/**
 * Build the default agent system prompt for a chat session.
 *
 * Extracted from stream/compact routes to avoid duplication.
 */
export function buildAgentSystemPrompt(options: {
  customInstructions?: string | null | undefined;
  toolConfig?: Record<string, unknown> | undefined;
}): string {
  const defaultPrompt = `You are Saale, a personal AI assistant built into a productivity workspace. You help with chat, email drafting, job management, calendar, and file organization.

Guidelines:
- Be concise and direct — get to the point without unnecessary preamble.
- Write naturally, like a capable colleague, not a generic AI.
- Use bullet points or short paragraphs when listing things.
- When uncertain, say so briefly rather than guessing.
- Match the user's tone and language preference.`;

  const customInstructions =
    options.customInstructions && options.customInstructions.trim()
      ? "\n\nCustom instructions:\n" + options.customInstructions
      : "";

  const toolConfig = options.toolConfig ?? {};
  const terminalInstruction =
    toolConfig.terminal === true
      ? "\n\nA Terminal is available to run commands and read/write files. Common utilities such as bash, wget, curl, python, yt-dlp.. are available."
      : "";

  const memoryInstruction =
    toolConfig.memory !== false
      ? "\n\nYou have a persistent memory system. If the user references something you don't know about, use `memory_search` to look it up before answering."
      : "";

  return defaultPrompt + customInstructions + terminalInstruction + memoryInstruction;
}

/**
 * Lock the system prompt on an agent session so the Pi SDK cannot overwrite it.
 *
 * The Pi SDK's `emitBeforeAgentStart` resets `agent.state.systemPrompt` to the
 * default Pi prompt when no extensions return an override. This function uses
 * `Object.defineProperty` to make `systemPrompt` a read-only getter that always
 * returns the Saale prompt, preventing the SDK from silently replacing it.
 *
 * Must be called after `createAgentSession` returns and before `session.agent.prompt()`.
 */
export function lockSystemPrompt(session: AgentSession, prompt: string): void {
  Object.defineProperty(session.agent.state, "systemPrompt", {
    get() {
      return prompt;
    },
    set() {
      // Silently ignore — the Saale system prompt is authoritative
    },
    configurable: false,
    enumerable: true,
  });
}

// ─── Background stale-state cleanup ─────────────────────────────────────

/**
 * Periodically clear stale processingSince flags.
 *
 * If the server crashes, a stream handler throws, or any other path fails
 * to clear processingSince, this safety net catches it. Runs every 5 minutes.
 */
const cleanupTimer = setInterval(
  async () => {
    try {
      const cleared = await clearStaleProcessingStates();
      if (cleared > 0) {
        // eslint-disable-next-line no-console
        console.log(`[processing-state] Cleared ${cleared} stale session(s)`);
      }
    } catch (err) {
      console.error("[processing-state] Stale cleanup failed:", err);
    }
  },
  5 * 60 * 1000,
);
cleanupTimer.unref(); // Don't keep process alive
