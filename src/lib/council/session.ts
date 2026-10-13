/**
 * One member's Pi session, for the length of one run.
 *
 * Built by hand rather than through `createSaaleAgentSession` for one reason:
 * that wrapper pins a session's cwd to the *user's* terminal home, which is
 * precisely the workspace a council must not have. Everything else it does is
 * reproduced here — in-memory Saale settings instead of the host's Pi config,
 * and a system-prompt resource loader instead of Pi's base prompt.
 *
 * The session is in-memory and lives for one run: a member's durable record is
 * the run's `CouncilMemberTurn` rows (its thinking, its tool calls, its unsent
 * closing text), and the *room* is the shared memory between members. A fresh
 * session per run is what keeps a member's private reasoning private to that
 * run, and keeps one member's context from growing without bound across runs.
 *
 * `resolveTools` is reused for the council's selected categories, with the
 * sandbox injected where it would otherwise build the user's own terminal
 * tools. Two things are subtracted from the result, both because they reach the
 * owner's data (see `COUNCIL_EXCLUDED_*`).
 */

import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { buildModelRuntime } from "@/lib/pi/models";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { createAgentResourceLoader, startSessionExtensions } from "@/lib/pi/processing-state";
import { createSessionSettings } from "@/lib/pi/settings";
import { thinkingLevelOption } from "@/lib/pi/thinking-levels";
import { resolveTools } from "@/lib/pi/tool-registry";
import { findToolInfo } from "@/lib/pi/tool-infos";
import {
  DEFAULT_TOOL_CONFIG,
  type ToolConfig,
  type ToolExposureConfig,
} from "@/lib/pi/tool-categories";
import { stopVoteQuorum, type CouncilOrchestration, type StopVoteThreshold } from "./config";
import { buildCouncilMemberPrompt, type CouncilMemberSummary } from "./prompt";
import { createCouncilSandbox, councilSandboxTools, type CouncilSandbox } from "./sandbox";
import { createCouncilTools, type CouncilToolContext } from "./tools";

/**
 * Tools a council is never given, whatever its tool selection says.
 *
 * `show_file` ships with the terminal bundle but reads a file the *owner*
 * uploaded to a chat — the one thing the sandbox exists to keep out. The
 * chat-history tools act on a conversation the council is not part of; they are
 * resolved from the same category registry a chat uses, so they are recognised
 * by category rather than by listing their names here.
 */
const COUNCIL_EXCLUDED_TOOLS = new Set(["show_file"]);
const COUNCIL_EXCLUDED_CATEGORIES = new Set(["chatSearch"]);

export interface CouncilMemberConfig {
  id: string;
  name: string;
  instructions: string | null;
  modelProvider: string | null;
  modelName: string | null;
  thinkingLevel: string;
  /** Per-member tool selection; null inherits the council's. */
  toolConfig: ToolConfig | null;
}

export interface CouncilMemberSessionOptions {
  userId: string;
  councilId: string;
  councilName: string;
  brief: string;
  orchestration: CouncilOrchestration;
  stopVoteThreshold: StopVoteThreshold;
  /** Members used for the roster and handle resolution (enabled ones). */
  members: CouncilMemberSummary[];
  /** The member's handle resolution source, paired with the roster above. */
  memberTargets: Array<{ id: string; name: string }>;
  member: CouncilMemberConfig;
  /** The council's tool selection, used where the member has none. */
  councilToolConfig: ToolConfig | null;
  toolExposure: ToolExposureConfig | null;
  sandboxKey: string;
  /** The room the member's tools act on. */
  toolContext: CouncilToolContext;
}

export interface CouncilMemberSession {
  session: AgentSession;
  sandbox: CouncilSandbox;
  /** The model the member will answer with, for the run log. */
  modelLabel: string;
}

/**
 * Create the member's session.
 *
 * Throws when no model can be resolved: a member without a model cannot take a
 * turn, and the run reports that as the member's failure rather than silently
 * prompting with Pi's own default.
 */
export async function createCouncilMemberSession(
  options: CouncilMemberSessionOptions,
): Promise<CouncilMemberSession> {
  const { member, userId, councilId } = options;

  const sandbox = createCouncilSandbox({
    councilId,
    sandboxKey: options.sandboxKey,
    userId,
  });

  const modelRef =
    member.modelProvider && member.modelName ? `${member.modelProvider}:${member.modelName}` : null;
  const resolved = await resolveModelForPurpose(userId, "chat", modelRef);
  if (!resolved) {
    throw new Error(
      `No model for council member "${member.name}". Set a default model in Settings, or pick one on the member.`,
    );
  }

  const { modelRuntime } = await buildModelRuntime(userId);
  const model = modelRuntime.getModel(resolved.provider, resolved.name);
  if (!model) {
    throw new Error(
      `Model ${resolved.provider}:${resolved.name} is not available for council member "${member.name}" — it may have been disabled or removed by the admin.`,
    );
  }

  // A member's own selection wins over the council's; both fall back to the
  // registry defaults, exactly as a chat's tool config does.
  const toolConfig: Required<ToolConfig> = {
    ...DEFAULT_TOOL_CONFIG,
    ...(options.councilToolConfig ?? {}),
    ...(member.toolConfig ?? {}),
  };

  const resolvedTools = await resolveTools(userId, councilId, toolConfig, {
    createTerminalScopedTools: async () => councilSandboxTools(sandbox),
    ...(options.toolExposure ? { exposure: options.toolExposure } : {}),
  });

  const categoryTools = resolvedTools.filter((tool) => {
    if (COUNCIL_EXCLUDED_TOOLS.has(tool.name)) return false;
    const category = findToolInfo(tool.name)?.category;
    return !(category && COUNCIL_EXCLUDED_CATEGORIES.has(category));
  });

  const prompt = buildCouncilMemberPrompt({
    councilName: options.councilName,
    brief: options.brief,
    member: { name: member.name, instructions: member.instructions },
    members: options.members,
    orchestration: options.orchestration,
    stopVoteThreshold: options.stopVoteThreshold,
    stopVoteQuorum: stopVoteQuorum(options.stopVoteThreshold, options.members.length),
    sandboxPath: sandbox.home,
  });

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    settingsManager: createSessionSettings(),
    // Only Pi's built-in file/shell tools are disabled: the sandboxed ones are
    // Saale's, and they arrive through `customTools` like every other tool.
    noTools: "builtin",
    model,
    customTools: [...createCouncilTools(options.toolContext), ...categoryTools],
    // No `interactive` context: a council run has nobody to approve a call and
    // no MCP servers, so codemode loads ungated and the member's tool policies
    // are the council's tool selection rather than a per-call question.
    resourceLoader: await createAgentResourceLoader({ prompt, cwd: sandbox.home }),
    // `createAgentSession` resolves `ctx.cwd` from here, and every tool path is
    // resolved against it — this is what puts the member in its own workspace.
    cwd: sandbox.home,
    ...thinkingLevelOption(member.thinkingLevel),
  });

  // Pi only emits `session_start` here, which is what activates codemode.
  await startSessionExtensions(session);

  return { session, sandbox, modelLabel: `${resolved.provider}:${resolved.name}` };
}

export type { CouncilSandbox };
