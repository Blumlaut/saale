import {
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

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
      ? "\n\nA Terminal is available to run commands and read/write files. Common utilities such as bash, wget, curl, python, yt-dlp.. are available. " +
        "Files the user uploads in chat are placed in the `uploads/` directory of the working directory — read them from there when the user refers to an attached file."
      : "";

  const memoryInstruction =
    toolConfig.memory !== false
      ? "\n\nYou have a persistent memory system. If the user references something you don't know about, use `memory_search` to look it up before answering."
      : "";

  return defaultPrompt + customInstructions + terminalInstruction + memoryInstruction;
}

/**
 * Build a resource loader that serves the given system prompt to a Pi session.
 *
 * pi v0.86 derives the system prompt from the resource loader: the loader's
 * `systemPrompt` becomes the prompt's preamble section and is replayed from
 * the transcript, so it survives the SDK's per-turn prompt resolution. Pass
 * the result to `createAgentSession` as `resourceLoader` — it does NOT reload
 * a caller-provided loader, hence the `reload()` here.
 *
 * Discovery (extensions, skills, prompt templates, themes, context files) is
 * disabled — Saale builds its own prompts and runs headless.
 */
export async function createSystemPromptLoader(
  prompt: string,
  cwd: string,
): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    systemPrompt: prompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}
