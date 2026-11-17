import {
  DefaultResourceLoader,
  createCodemodeExtension,
  getAgentDir,
  type AgentSession,
  type ExtensionFactory,
  type ExtensionUIContext,
  type ResourceDiagnostic,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { createUserMcpExtension } from "@/lib/mcp/servers";
import type { DecisionModelRef } from "./decision-model";
import { createToolApprovalExtension } from "./tool-approval-extension";
import {
  globalPluginPaths,
  pluginIdForPath,
  recordExtensionDiagnostics,
  recordPluginLog,
} from "./plugins";
import { hasFeature } from "@/lib/permissions/check";
import { createSessionSettings } from "./settings";
import {
  isInWorkspace,
  projectContextFiles,
  sessionSkillPaths,
  type SessionWorkspace,
} from "./project-context";
import { SESSION_ENV_NAMES } from "@/lib/sandbox/env-vars";
import type { McpScope } from "@/lib/mcp/shared";
import {
  isCategoryEnabled,
  CODEMODE_INLINE_BUDGET,
  type ToolConfig,
  type ToolExposureConfig,
} from "./tool-categories";
import type { SearchSources } from "@/lib/web/prompt";
import type { ApprovalRequest } from "./tool-approval-gate";

/**
 * Identity and response-style rules. always present, independent of tools.
 */
const IDENTITY_PROMPT = `You are Saale, a personal AI assistant. You help with chat, email, calendar, tasks and files.

Guidelines:
- Be concise and direct, in plain sentences.
- Never guess: say when you are unsure.
- Match the user's tone and language preference.`;

/**
 * Capability: reaching the tools that are not declared directly.
 *
 * Only what the `codemode` tool description (in every request, since codemode
 * is a declared tool) does not say: the mechanics of calling a tool, reading
 * its result, `store`/`load` and `searchTools` are all in that description.
 * This adds that most tools live behind codemode and must be looked for, that
 * independent calls batch into one script, and that a result pasted into the
 * script text stops it parsing.
 */
export const TOOLS_PROMPT = `Tool use:
Most of your tools are not declared to you. Before you act in an area you cannot see, or tell the user you cannot do something, look for the tool: \`await searchTools("what you need")\` in a \`codemode\` script finds anything not listed, MCP tools included. Batch independent calls into one script. Keep a result in a variable or \`store(key, value)\`; never paste a result into the script text, where it stops the script parsing.`;

/**
 * Capability: shell + files via the terminal tool.
 *
 * The file-tool mechanics (an exact, unique `edits[].oldText`, merging nearby
 * changes) sit in the `edit` tool description, declared with the terminal
 * category, so this only steers which tool does the job.
 */
const TERMINAL_PROMPT = `A Terminal runs commands and reads/writes files; bash, wget, curl, python, yt-dlp and the like are installed. Files the user uploads in chat are in \`uploads/\`.
Use \`read\` rather than cat/sed, \`write\` for new files or rewrites, \`edit\` for precise changes, and \`bash\` to list and search. Scratch files and throwaway output go under \`.tmp/\`, which is emptied automatically.`;

/**
 * The terminal block, plus what the user has already configured.
 *
 * Names only: the model needs to know `gh` is authenticated, not what the token
 * is. A value in a prompt is a value in a transcript.
 */
function terminalSection(envNames: string[]): string {
  const saaleVars = `Commands also see these variables, set by Saale: ${SESSION_ENV_NAMES.map(
    (name) => `\`${name}\``,
  ).join(", ")}. They name the chat and the model answering in it.`;
  if (envNames.length === 0) return `${TERMINAL_PROMPT}\n${saaleVars}`;
  return `${TERMINAL_PROMPT}\n${saaleVars}\nCommands receive these environment variables, set by the user: ${envNames.join(
    ", ",
  )}. Their values are not shown to you.`;
}

/** Capability: persistent memory. Defaults on. */
const MEMORY_PROMPT = `You have a persistent memory system. If the user references something you don't know about, search it with \`memory_search\` before answering. Save durable facts and preferences the user states with \`memory_create\`; correct them with \`memory_update\`, remove stale ones with \`memory_delete\`.`;

/**
 * Capability: SSH machines and the notes that describe them.
 *
 * The prompt carries the decision rules — read the notes before touching a
 * machine, record durable knowledge, and not every task earns a note. The
 * writing contract (verified present-state facts only, no ephemeral values,
 * update by id instead of duplicating, delete when stale) lives in the
 * `infra_notes_upsert` and `infra_notes_delete` descriptions, which the model
 * reads right before it writes.
 */
const INFRA_PROMPT = `Infrastructure notes:
You can manage the user's registered machines over SSH. Each machine's notes are the durable record of what it is right now; read them (\`infra_notes_list\`) before you inspect or change it. When you learn durable knowledge, record it with \`infra_notes_upsert\`; not every task earns a note. Move files with \`infra_download_file\` and \`infra_upload_file\` (binary or too large to read as text).`;

/**
 * Capability: reaching the user on Telegram between conversations.
 *
 * The message rules (short, self-contained, an interruption) sit in the
 * `telegram_send` description; this only says the capability exists and when
 * it is the answer.
 */
const TELEGRAM_PROMPT = `You can reach the user outside this app with \`telegram_send\`: their own chat on their phone. It is the only way to reach them after this conversation ends, so use it for reminders and anything they asked to be told.`;

/**
 * Capability: giving an outreach message a time to go out.
 *
 * Only composed when automations are available too. a message that must be sent
 * later needs a schedule behind it, and naming `automation_create` to a session
 * without it would describe a tool the model cannot call.
 */
const TELEGRAM_SCHEDULE_PROMPT = `A message that has to go out later needs a schedule: create an automation (\`automation_create\`) with \`maxFires: 1\` and \`deliver: "silent"\`, whose script sends it with \`telegram_send\`. Do that instead of promising to remember.`;

/** Capability: work that outlasts the turn, handed to a script. */
const AUTOMATION_PROMPT = `Long-running work (a build, a deploy, a file appearing) belongs in an automation: \`automation_create\` with a script that checks on its own schedule and returns a value only when there is news.`;

/** Capability: searching the web, worded with the instance's own names. */
export function webSearchSection(sources: SearchSources): string {
  // A model that guesses at a category name gets general results back with no
  // warning, so the instance's own names are the only ones worth saying.
  const names =
    sources.categories.length > 0
      ? `Its categories: ${sources.categories.join(", ")}.`
      : "It answers to SearXNG's category names, such as general, news, images and science.";
  const defaults = `A search that names no category uses ${sources.defaults.join(", ")}.`;
  const engines =
    sources.engines.length > 0
      ? ` Searches are limited to these engines: ${sources.engines.join(", ")}.`
      : "";
  return `Web search:
\`web_search\` searches through this workspace's SearXNG instance. ${names} ${defaults}${engines}`;
}

/**
 * The capability blocks for the tool categories a session has enabled.
 *
 * Shared by the chat prompt and the coder prompt: a category describes its
 * tools in one place, so the two prompts cannot drift, and a category that is
 * off contributes nothing. Callers supply their own identity and rules around
 * these blocks.
 */
export function capabilitySections(
  toolConfig: Record<string, boolean | undefined> = {},
  sandboxEnvNames: string[] = [],
  /**
   * Whether any tool this session can call is reached through codemode. False
   * drops the explanation of a tool set the session declared in full: the model
   * would be told to go looking for what is already in front of it.
   */
  codemodeTools: boolean = true,
  /**
   * Where search runs, for a session with the web tools. Absent leaves the
   * block out: without the instance there is nothing to name.
   */
  searchSources?: SearchSources | undefined,
): string[] {
  // Resolve through the category registry, exactly as `resolveTools` does: an
  // absent key means the category sits at its default, not off. Reading the raw
  // snapshot with `=== true` dropped the Terminal block. and with it any mention
  // of `write`. for every chat whose stored `toolConfig` was null.
  const terminalEnabled =
    isCategoryEnabled(toolConfig, "terminal") ||
    toolConfig.files === true ||
    toolConfig.bash === true;

  const telegramEnabled = isCategoryEnabled(toolConfig, "telegram");

  const sections = [
    codemodeTools ? TOOLS_PROMPT : null,
    terminalEnabled ? terminalSection(sandboxEnvNames) : null,
    isCategoryEnabled(toolConfig, "memory") ? MEMORY_PROMPT : null,
    isCategoryEnabled(toolConfig, "web") && searchSources ? webSearchSection(searchSources) : null,
    isCategoryEnabled(toolConfig, "infra") ? INFRA_PROMPT : null,
    telegramEnabled ? TELEGRAM_PROMPT : null,
    telegramEnabled && isCategoryEnabled(toolConfig, "watchers") ? TELEGRAM_SCHEDULE_PROMPT : null,
    isCategoryEnabled(toolConfig, "watchers") ? AUTOMATION_PROMPT : null,
  ];

  return sections.filter((section): section is string => section !== null);
}

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
  /** Names of the user's sandbox variables. never their values. */
  sandboxEnvNames?: string[] | undefined;
  /** Whether the session has tools behind codemode. See `capabilitySections`. */
  codemodeTools?: boolean | undefined;
  /** Where search runs. See `capabilitySections`. */
  searchSources?: SearchSources | undefined;
}): string {
  const toolConfig = (options.toolConfig ?? {}) as Record<string, boolean | undefined>;
  const customInstructions = options.customInstructions?.trim();

  const sections = [
    IDENTITY_PROMPT,
    customInstructions ? `Custom instructions:\n${customInstructions}` : null,
    ...capabilitySections(
      toolConfig,
      options.sandboxEnvNames ?? [],
      options.codemodeTools,
      options.searchSources,
    ),
  ];

  return sections.filter((section): section is string => section !== null).join("\n\n");
}

/**
 * Build a resource loader that serves the given system prompt to a Pi session.
 *
 * pi v0.86 derives the system prompt from the resource loader: the loader's
 * `systemPrompt` becomes the prompt's preamble section and is replayed from
 * the transcript, so it survives the SDK's per-turn prompt resolution. Pass
 * the result to `createAgentSession` as `resourceLoader`. it does NOT reload
 * a caller-provided loader, hence the `reload()` here.
 *
 * Discovery (extensions, skills, prompt templates, themes, context files) is
 * disabled. Saale builds its own prompts and runs headless. along with the
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
  return [createCodemodeExtension({ inlineBudget: CODEMODE_INLINE_BUDGET })];
}

export interface AgentResourceOptions {
  prompt: string;
  cwd: string;
  /**
   * The workspace the session works in. Given, the session reads the project's
   * AGENTS.md files, its `.pi/skills`, and the skills the user installed.
   */
  workspace?: SessionWorkspace | undefined;
  /**
   * Which categories this session's tools cover (`mcp` among them). The MCP
   * servers follow the same switches as the tools Saale builds itself.
   */
  toolConfig?: ToolConfig | null | undefined;
  /** How each category's tools reach the model, MCP tools included. */
  toolExposure?: ToolExposureConfig | null | undefined;
  /**
   * The user behind the tools a session can call.
   *
   * Passing this connects the user's MCP servers and installs the approval
   * gate over every call the session makes. a run with nobody to ask (an agent
   * job) passes nothing and gets neither.
   */
  interactive?: {
    userId: string;
    /** ChatSession/agent session id used on approval cards. */
    sessionId: string;
    toolPolicies: Record<string, string> | null | undefined;
    /** Where the session runs: only the MCP servers switched on for it connect. */
    mcpScope: McpScope;
    /** Set for a coder chat: shell commands are judged by the workspace. */
    commandScope?: "workspace" | undefined;
    emitApprovalRequest: (request: ApprovalRequest) => void;
    /** The decision model that judges what `auto` would run (see `decision-model.ts`). */
    decisionModel?: DecisionModelRef | null | undefined;
  };
}

/**
 * Build a resource loader for a session that can call tools.
 *
 * Adds the extensions Saale runs (codemode), the admin's global plugins, and
 * given an interactive context, the user's MCP servers with the gates that
 * enforce their approval policies.
 */
export async function createAgentResourceLoader(
  options: AgentResourceOptions,
): Promise<ResourceLoader> {
  const extensionFactories = baseExtensionFactories();

  if (options.interactive) {
    const interactive = options.interactive;
    // Without the MCP feature the user's servers are never connected, so no MCP
    // tool reaches the model through codemode either. The `mcp` category switch
    // and its exposure are read here, with the rest of the session's tools.
    const mcp = (await hasFeature(interactive.userId, "mcp"))
      ? await createUserMcpExtension(interactive.userId, {
          scope: interactive.mcpScope,
          sessionId: interactive.sessionId,
          toolConfig: options.toolConfig,
          exposure: options.toolExposure,
        })
      : null;

    // One gate for every tool call the session can make, whichever way the
    // tool was registered: Saale's own, a plugin's, an MCP server's, or a
    // codemode script's nested call.
    extensionFactories.push(
      createToolApprovalExtension({
        userId: interactive.userId,
        sessionId: interactive.sessionId,
        toolPolicies: interactive.toolPolicies,
        mcpServerPolicies: mcp?.policies ?? {},
        ...(interactive.commandScope === "workspace" && options.workspace
          ? { commandScope: { root: options.workspace.root, cwd: options.workspace.cwd } }
          : {}),
        emitApprovalRequest: interactive.emitApprovalRequest,
        ...(interactive.decisionModel ? { decisionModel: interactive.decisionModel } : {}),
      }),
    );

    if (mcp) extensionFactories.push(mcp.extension);
  }

  const workspace = options.workspace;
  // Pi reads context files and skills from a working directory. Inside a
  // workspace that directory is the user's own, so its root takes the place of
  // the host's agent dir.
  const discoveryCwd = workspace?.cwd ?? options.cwd;

  const loader = new DefaultResourceLoader({
    cwd: discoveryCwd,
    agentDir: workspace?.root ?? getAgentDir(),
    settingsManager: createSessionSettings(),
    systemPrompt: options.prompt,
    extensionFactories,
    // The admin's plugin directory. `noExtensions` still keeps the host's own
    // Pi settings out: these paths are the only file extensions that load.
    additionalExtensionPaths: await globalPluginPaths(),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    // A session outside a workspace has no directory of its own to read.
    noContextFiles: !workspace,
    noSkills: !workspace,
    additionalSkillPaths: workspace ? await sessionSkillPaths(workspace) : [],
    // An empty list, not an omitted option: Pi otherwise *discovers*
    // `<agentDir>/APPEND_SYSTEM.md`, which is `getAgentDir()`. the host's Pi
    // directory. Its owner's text would be appended to every tenant's prompt.
    appendSystemPrompt: [],
    // Pi walks from the working directory up to the filesystem root and reads
    // the host's own `~/.agents/skills`; above and beside the workspace root is
    // the operator's, not the tenant's.
    ...(workspace
      ? {
          agentsFilesOverride: () => ({ agentsFiles: projectContextFiles(workspace) }),
          skillsOverride: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => ({
            ...base,
            skills: base.skills.filter((skill) => isInWorkspace(workspace, skill.filePath)),
          }),
        }
      : {}),
  });
  await loader.reload();
  // A plugin that fails to load must not fail the session, but it must not
  // disappear either: the admin's log carries the reason.
  recordExtensionDiagnostics(loader.getExtensions());
  return loader;
}

/** Extension-provided tools every Saale session runs. */
export const DEFAULT_EXTENSION_TOOLS = ["codemode"];

/** Sessions already wired to the plugin log, so a re-bind does not double-log. */
const loggingSessions = new WeakSet<AgentSession>();

/**
 * Start a session's extensions and enable the tools Saale runs with them.
 *
 * Pi emits `session_start` only from `bindExtensions()`; without this call the
 * extensions never activate. the user's MCP servers never connect and Pi's
 * `codemode` tool (registered inactive) is never enabled. It must run once per
 * session, after `createAgentSession`.
 *
 * `uiContext` is what an extension's `ctx.ui` resolves to. Given, `ctx.hasUI`
 * is true and dialogs reach the chat; omitted (an unattended run), Pi's no-op
 * context answers every dialog as cancelled.
 */
export async function startSessionExtensions(
  session: AgentSession,
  options: { uiContext?: ExtensionUIContext } = {},
): Promise<void> {
  // A plugin handler that throws is reported by Pi to this listener and nowhere
  // else. Attached before binding so `session_start` failures are caught too.
  if (!loggingSessions.has(session)) {
    loggingSessions.add(session);
    session.extensionRunner.onError((error) => {
      recordPluginLog(
        "error",
        pluginIdForPath(error.extensionPath),
        `${error.event}: ${error.error}`,
      );
    });
  }

  await session.bindExtensions(
    options.uiContext ? { uiContext: options.uiContext, mode: "rpc" } : {},
  );
  const active = session.getActiveToolNames();
  const missing = DEFAULT_EXTENSION_TOOLS.filter((name) => !active.includes(name));
  if (missing.length > 0) session.setActiveToolsByName([...active, ...missing]);
}
