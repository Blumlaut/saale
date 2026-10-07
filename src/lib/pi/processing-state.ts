import {
  DefaultResourceLoader,
  createCodemodeExtension,
  getAgentDir,
  type AgentSession,
  type ExtensionFactory,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createUserMcpExtension } from "@/lib/mcp/servers";
import { createCodemodeApprovalExtension } from "./codemode-approval";
import { createMcpToolPolicyExtension } from "./mcp-tool-policy";
import { createSessionSettings } from "./settings";
import { isCategoryEnabled } from "./tool-categories";
import type { ApprovalRequest } from "./tool-approval-gate";

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

/**
 * Capability: reaching the tools that are not declared directly.
 *
 * Most categories are hidden behind codemode by default, and Pi's own
 * "use codemode to batch calls" guideline only exists in its default system
 * prompt — which a custom prompt replaces. Without this, the model sees the
 * `codemode` tool but is never told that the tools it needs are inside it.
 */
export const TOOLS_PROMPT = `Tool use:
Not every tool is listed to you directly. Reach the rest by writing a short JavaScript script with the \`codemode\` tool — \`await tools.<name>({ ...args })\` — and batch independent calls into one script (\`Promise.allSettled\`), reducing large output there, instead of issuing many separate calls. If a tool you need is not listed, find it with \`searchTools("what you need")\`. Only the script's output comes back to you.`;

/** Capability: shell + files via the terminal tool. */
const TERMINAL_PROMPT = `A Terminal is available to run commands and read/write files. Common utilities such as bash, wget, curl, python, yt-dlp.. are available. Files the user uploads in chat are placed in the \`uploads/\` directory of the working directory — read them from there when the user refers to an attached file.
Read with \`read\` rather than cat/sed, use \`bash\` to list, search and find files, use \`write\` only for new files or complete rewrites, and use \`edit\` for precise changes — each \`edits[].oldText\` must match the file exactly, kept small and unique, with nearby changes merged into one call.`;

/** Capability: persistent memory. Defaults on. */
const MEMORY_PROMPT = `You have a persistent memory system. If the user references something you don't know about, use \`memory_search\` to look it up before answering; \`memory_index\` lists what collections exist, and \`memory_delete\` removes a memory that is wrong or stale.`;

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

Files move between a machine and your workspace with \`infra_download_file\` (into the workspace, where the local file tools can read and change them) and \`infra_upload_file\` (back to the machine). Use them for binary files and files too large to read as text.

When you write or update a note:
- Record only facts you have verified are true now. Never record plans, intentions, TODOs, proposals or "we should…" — if it is not in place yet, it is not a note.
- Record stable facts, not values that move on their own: ephemeral addresses, process IDs, free-disk figures, raw command output, or a version mid-upgrade. Capture the durable truth underneath — "nginx serves :80 on the docker network", not the output of the command that revealed it.
- Keep each topic in exactly one note. List the machine's notes first and update the matching note by id; create a new note only when no existing note covers the topic.
- A stale note is worse than no note. When reality changes, rewrite the affected note in the same turn; when a note stops being true and nothing replaces it, delete it.
- Not every task earns a note. Write one only when you have learned durable knowledge that is not already recorded.`;

/** Capability: reaching the user on Telegram between conversations. */
const TELEGRAM_PROMPT = `You can reach the user outside this app with \`telegram_send\` — it goes to their own Telegram chat, and the recipient cannot be chosen. It is the only way to tell them something after this conversation ends, so use it whenever they ask to be reminded or told about something. It arrives on their phone: keep it short, self-contained, and only send it when it is worth interrupting them.`;

/**
 * Capability: giving an outreach message a time to go out.
 *
 * Only composed when agent jobs are available too — a message that must be sent
 * later needs a schedule behind it, and naming `agent_job_create` to a session
 * without it would describe a tool the model cannot call.
 */
const TELEGRAM_SCHEDULE_PROMPT = `A message that has to go out later needs a schedule behind it: create a one-off agent job (\`agent_job_create\` with \`runAt\`) whose output channel is Telegram, and it will reach the user at that time. Do that instead of promising to remember.`;

/**
 * Build the default agent system prompt for a chat session.
 *
 * Sections are composed in priority order: identity first, then the user's
 * own instructions, then the instructions for the tools this session has.
 * A capability block appears only when its tools are actually available, so the
 * prompt never describes a tool the session cannot call.
 */
export function buildAgentSystemPrompt(options: {
  customInstructions?: string | null | undefined;
  toolConfig?: Record<string, unknown> | undefined;
}): string {
  const toolConfig = (options.toolConfig ?? {}) as Record<string, boolean | undefined>;
  const customInstructions = options.customInstructions?.trim();

  // Resolve through the category registry, exactly as `resolveTools` does: an
  // absent key means the category sits at its default, not off. Reading the raw
  // snapshot with `=== true` dropped the Terminal block — and with it any mention
  // of `write` — for every chat whose stored `toolConfig` was null.
  const terminalEnabled =
    isCategoryEnabled(toolConfig, "terminal") ||
    toolConfig.files === true ||
    toolConfig.bash === true;

  const telegramEnabled = isCategoryEnabled(toolConfig, "telegram");

  const sections = [
    IDENTITY_PROMPT,
    customInstructions ? `Custom instructions:\n${customInstructions}` : null,
    TOOLS_PROMPT,
    terminalEnabled ? TERMINAL_PROMPT : null,
    isCategoryEnabled(toolConfig, "memory") ? MEMORY_PROMPT : null,
    isCategoryEnabled(toolConfig, "infra") ? INFRA_PROMPT : null,
    telegramEnabled ? TELEGRAM_PROMPT : null,
    telegramEnabled && isCategoryEnabled(toolConfig, "agentJobs") ? TELEGRAM_SCHEDULE_PROMPT : null,
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
 *
 * For sessions that can call tools, use `createAgentResourceLoader` (this is
 * its no-tools form) so codemode and the user's MCP servers are loaded.
 */
export async function createSystemPromptLoader(
  prompt: string,
  cwd: string,
): Promise<ResourceLoader> {
  return createAgentResourceLoader({ prompt, cwd });
}

/** Extensions every Saale session loads. */
function baseExtensionFactories(): ExtensionFactory[] {
  // Saale runs `codemode` by default: the model can write a short script that
  // calls several tools in parallel and reduces the results, which keeps both
  // the prompt and the transcript smaller than issuing every call itself. It is
  // also how MCP tools are reached (`codemode` is their default exposure).
  return [createCodemodeExtension()];
}

export interface AgentResourceOptions {
  prompt: string;
  cwd: string;
  /**
   * The user behind the tools Pi registers after the session exists.
   *
   * `codemode` comes from its extension and MCP tools from the user's servers —
   * both are registered at `session_start`, so neither passes through
   * `wrapTool` and each needs a gate of its own. Passing this connects those
   * servers and gates every registered tool with the user's approval policies;
   * a run with nobody to ask (an agent job) passes nothing and gets neither.
   */
  interactive?: {
    userId: string;
    /** ChatSession/agent session id used on approval cards. */
    sessionId: string;
    toolPolicies: Record<string, string> | null | undefined;
    emitApprovalRequest: (request: ApprovalRequest) => void;
  };
}

/**
 * Build a resource loader for a session that can call tools.
 *
 * Adds the extensions Saale runs (codemode) and, given an interactive context,
 * the user's MCP servers with the gates that enforce their approval policies.
 */
export async function createAgentResourceLoader(
  options: AgentResourceOptions,
): Promise<ResourceLoader> {
  const extensionFactories = baseExtensionFactories();

  if (options.interactive) {
    const interactive = options.interactive;
    const mcp = await createUserMcpExtension(interactive.userId);

    // The script gate needs the servers' policies: a script reaches MCP tools
    // like any other, and whether one of those calls asks is resolved the same
    // way a direct call resolves it.
    extensionFactories.push(
      createCodemodeApprovalExtension({
        ...interactive,
        mcpServerPolicies: mcp?.policies ?? {},
      }),
    );

    if (mcp) {
      extensionFactories.push(
        mcp.extension,
        createMcpToolPolicyExtension({ ...interactive, serverPolicies: mcp.policies }),
      );
    }
  }

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    settingsManager: createSessionSettings(),
    systemPrompt: options.prompt,
    extensionFactories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // An empty list, not an omitted option: Pi otherwise *discovers*
    // `<agentDir>/APPEND_SYSTEM.md`, which is `getAgentDir()` — the host's Pi
    // directory. Its owner's text would be appended to every tenant's prompt.
    appendSystemPrompt: [],
  });
  await loader.reload();
  return loader;
}

/** Extension-provided tools every Saale session runs. */
export const DEFAULT_EXTENSION_TOOLS = ["codemode"];

/**
 * Start a session's extensions and enable the tools Saale runs with them.
 *
 * Pi emits `session_start` only from `bindExtensions()`; without this call the
 * extensions never activate — the user's MCP servers never connect and Pi's
 * `codemode` tool (registered inactive) is never enabled. It must run once per
 * session, after `createAgentSession`.
 */
export async function startSessionExtensions(session: AgentSession): Promise<void> {
  await session.bindExtensions({});
  const active = session.getActiveToolNames();
  const missing = DEFAULT_EXTENSION_TOOLS.filter((name) => !active.includes(name));
  if (missing.length > 0) session.setActiveToolsByName([...active, ...missing]);
}
