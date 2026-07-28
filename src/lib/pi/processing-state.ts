import type { AgentSession } from "@earendil-works/pi-coding-agent";

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
 * The Pi SDK's `prepareNextTurnWithContext` uses
 * `this._systemPromptOverride ?? this._baseSystemPrompt` to determine the
 * system prompt sent to the model — NOT `agent.state.systemPrompt` (which is
 * just a reflection property). `emitBeforeAgentStart` resets
 * `_systemPromptOverride` to undefined when no extensions return an override,
 * causing the default Pi prompt (`_baseSystemPrompt`) to be used.
 *
 * This function overwrites `_baseSystemPrompt` with the Saale prompt and locks
 * both the internal and external properties to prevent the SDK from replacing it.
 *
 * Must be called after `createAgentSession` returns and before `session.agent.prompt()`.
 */
export function lockSystemPrompt(session: AgentSession, prompt: string): void {
  // @ts-expect-error — _baseSystemPrompt is internal to the Pi SDK
  session._baseSystemPrompt = prompt;
  // @ts-expect-error — _systemPromptOverride is internal to the Pi SDK
  session._systemPromptOverride = prompt;

  // Lock agent.state.systemPrompt (reflection property used by getSystemPrompt)
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
