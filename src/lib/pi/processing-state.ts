import {
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createSessionSettings } from "./settings";

/**
 * Identity and response-style rules — always present, independent of tools.
 */
const IDENTITY_PROMPT = `You are Saale, a personal AI assistant built into a productivity workspace. You help with chat, email drafting, job management, calendar, and file organization.

Guidelines:
- Be concise and direct — get to the point without unnecessary preamble.
- Write naturally, like a capable colleague, not a generic AI.
- Use bullet points or short paragraphs when listing things.
- When uncertain, say so briefly rather than guessing.
- Match the user's tone and language preference.`;

/** Capability: shell + files via the terminal tool. */
const TERMINAL_PROMPT = `A Terminal is available to run commands and read/write files. Common utilities such as bash, wget, curl, python, yt-dlp.. are available. Files the user uploads in chat are placed in the \`uploads/\` directory of the working directory — read them from there when the user refers to an attached file.`;

/** Capability: persistent memory. Defaults on. */
const MEMORY_PROMPT = `You have a persistent memory system. If the user references something you don't know about, use \`memory_search\` to look it up before answering.`;

/**
 * Capability: SSH machines and the notes that describe them.
 *
 * Notes are a knowledge base, not a scratchpad: the value of the tool depends
 * entirely on every note being a current, non-duplicated fact. That contract
 * is stated here (read-first, is-state-only, update-don't-duplicate,
 * delete-when-stale) because the model decides whether to consult and write
 * notes *before* it ever reads a tool description. The note tool descriptions
 * repeat the contract because agent jobs run on their own system prompt.
 */
const INFRA_PROMPT = `Infrastructure notes:
You can manage the user's registered machines over SSH. Each machine has a set of notes: the durable record of what that machine is right now — services, paths, configuration, quirks and credentials. Read them (\`infra_notes_list\`) before you inspect or change a machine; they are the source of truth, not a scratchpad.

When you write or update a note:
- Record only facts you have verified are true now. Never record plans, intentions, TODOs, proposals or "we should…" — if it is not in place yet, it is not a note.
- Record stable facts, not values that move on their own: ephemeral addresses, process IDs, free-disk figures, raw command output, or a version mid-upgrade. Capture the durable truth underneath — "nginx serves :80 on the docker network", not the output of the command that revealed it.
- Keep each topic in exactly one note. List the machine's notes first and update the matching note by id; create a new note only when no existing note covers the topic.
- A stale note is worse than no note. When reality changes, rewrite the affected note in the same turn; when a note stops being true and nothing replaces it, delete it.
- Not every task earns a note. Write one only when you have learned durable knowledge that is not already recorded.`;

/**
 * Build the default agent system prompt for a chat session.
 *
 * Sections are composed in priority order: identity first, then the user's
 * own instructions, then one block per enabled capability. A capability block
 * appears only when its tools are actually available, so the prompt never
 * describes a tool the session cannot call.
 */
export function buildAgentSystemPrompt(options: {
  customInstructions?: string | null | undefined;
  toolConfig?: Record<string, unknown> | undefined;
}): string {
  const toolConfig = options.toolConfig ?? {};
  const customInstructions = options.customInstructions?.trim();

  const sections = [
    IDENTITY_PROMPT,
    customInstructions ? `Custom instructions:\n${customInstructions}` : null,
    toolConfig.terminal === true ? TERMINAL_PROMPT : null,
    // Memory is on unless explicitly disabled; terminal and infra default off.
    toolConfig.memory !== false ? MEMORY_PROMPT : null,
    toolConfig.infra === true ? INFRA_PROMPT : null,
  ];

  return sections.filter((section): section is string => section !== null).join("\n\n");
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
 * disabled — Saale builds its own prompts and runs headless — along with the
 * host's Pi settings (see `createSessionSettings`).
 */
export async function createSystemPromptLoader(
  prompt: string,
  cwd: string,
): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: createSessionSettings(),
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
