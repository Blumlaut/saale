/**
 * The approval gate: the one place a tool call is allowed, blocked or put to
 * the user.
 *
 * Pi runs a `tool_call` handler for every call before it executes, whichever
 * way the tool was registered: Saale's own tools, Pi's built-ins, the tools a
 * plugin or an MCP server registers after the session exists, and the nested
 * calls a codemode script makes through `ctx.executeTool()` (those carry
 * `parentToolCallId`). Gating here rather than wrapping the definitions is what
 * makes the policies apply to the whole set, including tools that did not exist
 * when the session was built.
 *
 * The decision, in order:
 *
 * 1. `off`. blocked, and not even auto-approve mode re-enables it.
 * 2. Auto-approve mode (`/stfu`) is on for the user. everything that would ask
 *    runs. still never a tool set to `off`.
 * 3. `codemode`. the script is the approval unit: one card listing the calls
 *    that would ask on their own, and one click standing in for all of them
 *    (see `approval-scope.ts`).
 * 4. A call already covered by the script approval the user gave. runs.
 * 5. `auto` on a command-aware tool (`bash`, `infra_exec`). the command decides;
 *    risky ones ask, safe ones run.
 * 6. `ask`. the user decides.
 * 7. `allow`. runs.
 *
 * A tool nobody configured (a plugin's, say) has no catalog entry, so its own
 * declaration decides: read-only is harmless and runs, and anything that can
 * write or reach outside the workspace asks. Unknown stays `ask` — fail closed.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { McpToolPolicy } from "@/lib/mcp/shared";
import { grantApprovalScope, isApprovalScopeGranted, releaseApprovalScope } from "./approval-scope";
import { isAutoApproveActive } from "./auto-approve";
import { classifyCommand } from "./command-classifier";
import { readScriptToolReferences, resolveReferencedTools } from "./codemode-script";
import {
  APPROVAL_TIMEOUT_MS,
  requestToolApproval,
  type ApprovalRequest,
} from "./tool-approval-gate";
import { CODEMODE_TOOL_NAME, type ToolPolicy } from "./tool-infos";
import { resolveToolPolicy, type ToolPolicyContext } from "./tool-policy";

/** Tools whose "auto" policy is decided from the command they run. */
const COMMAND_AWARE_TOOLS = new Set(["infra_exec", "bash"]);

export interface ToolApprovalOptions {
  userId: string;
  /** ChatSession/agent session id the approval card is published under. */
  sessionId: string;
  /** The user's per-tool policies (`AppSettings.toolPolicies`). */
  toolPolicies: Record<string, string> | null | undefined;
  /** Policy per MCP server, keyed by `mcpNameKey(name)`. */
  mcpServerPolicies?: Record<string, McpToolPolicy>;
  /** Where an approval request goes: the web session bus, a Telegram card, … */
  emitApprovalRequest: (request: ApprovalRequest) => void;
}

/** Build the gate applied to every tool call of a session. */
export function createToolApprovalExtension(options: ToolApprovalOptions): ExtensionFactory {
  const policies: ToolPolicyContext = {
    toolPolicies: options.toolPolicies,
    ...(options.mcpServerPolicies ? { mcpServerPolicies: options.mcpServerPolicies } : {}),
  };

  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const toolName = event.toolName;
      const input = event.input as Record<string, unknown>;
      const policy = resolveToolPolicy(toolName, policies, {
        readOnly: isReadOnlyTool(pi, toolName),
      });

      if (policy === "off") {
        return { block: true, reason: `Tool "${toolName}" is disabled in the user's settings.` };
      }

      // Accepting everything that would ask; `off` never comes back this way.
      if (await isAutoApproveActive(options.userId)) return undefined;

      // A script is one decision covering the calls it announces.
      if (toolName === CODEMODE_TOOL_NAME && !event.parentToolCallId) {
        return decideScript({
          policy,
          toolCallId: event.toolCallId,
          input,
          pi,
          context: policies,
          gate: options,
          signal: ctx.signal,
        });
      }

      // The user already approved this call as part of the script that
      // announced it; asking again would undo the one-click decision.
      if (
        isApprovalScopeGranted({
          sessionId: options.sessionId,
          toolCallId: event.toolCallId,
          toolName,
        })
      ) {
        return undefined;
      }

      if (policy === "auto") {
        // "auto" on a tool whose decision is not made from its arguments is
        // just "allow".
        if (!COMMAND_AWARE_TOOLS.has(toolName)) return undefined;
        const command = typeof input.command === "string" ? input.command : "";
        const classification = command
          ? classifyCommand(command)
          : { safety: "risky" as const, reason: "no command provided" };
        if (classification.safety !== "risky") return undefined;
      } else if (policy !== "ask") {
        return undefined;
      }

      return ask({
        toolCallId: event.toolCallId,
        toolName,
        input,
        gate: options,
        signal: ctx.signal,
      });
    });

    // The script has finished (or was aborted): its approval covers nothing.
    pi.on("tool_result", (event) => {
      if (event.toolName === CODEMODE_TOOL_NAME && !event.parentToolCallId) {
        releaseApprovalScope(options.sessionId, event.toolCallId);
      }
      return undefined;
    });
  };
}

/** Put one call to the user, and turn the answer into a block or a pass. */
async function ask(options: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  gate: ToolApprovalOptions;
  signal?: AbortSignal | undefined;
  batch?: { tools: string[]; dynamic?: boolean };
}): Promise<{ block: true; reason: string } | undefined> {
  const { toolCallId, toolName } = options;
  const outcome = await requestToolApproval({
    toolCallId,
    toolName,
    userId: options.gate.userId,
    sessionId: options.gate.sessionId,
    args: options.input,
    emitApprovalRequest: options.gate.emitApprovalRequest,
    signal: options.signal,
    ...(options.batch ? { batch: options.batch } : {}),
  });

  if (outcome === "aborted") {
    return { block: true, reason: `The run was stopped while "${toolName}" awaited approval.` };
  }
  if (outcome !== "approved") {
    return {
      block: true,
      reason: `Tool call "${toolName}" was denied by the user (approval timed out or was rejected).`,
    };
  }
  return undefined;
}

/**
 * Decide a codemode script.
 *
 * A script's calls each carry their own policy, so gating them one by one puts
 * a card in front of the user per call — the same decision, asked N times. The
 * script is the approval unit instead: the card lists the calls that would ask
 * on their own, and the answer covers exactly those (`approval-scope.ts`).
 *
 * What the card covers is read from the script's source, so a call to a tool
 * the script reaches by a computed name is not covered and asks for itself. The
 * card says so, so an approval never reads as a blanket one.
 */
async function decideScript(options: {
  policy: ToolPolicy;
  toolCallId: string;
  input: Record<string, unknown>;
  pi: ExtensionAPI;
  context: ToolPolicyContext;
  gate: ToolApprovalOptions;
  signal: AbortSignal | undefined;
}): Promise<{ block: true; reason: string } | undefined> {
  // Allowed: the script runs as one step, and every call it makes follows its
  // own policy — that is what the rest of this gate is for.
  if (options.policy === "allow") return undefined;

  const code = typeof options.input.code === "string" ? options.input.code : "";
  const references = readScriptToolReferences(code);
  const covered = referencedCallsNeedingApproval(references, options.pi, options.context);

  // "auto" (the default): only a decision to make when the script reaches
  // something that would ask for itself.
  if (options.policy === "auto" && covered.length === 0) return undefined;

  const denied = await ask({
    toolCallId: options.toolCallId,
    toolName: CODEMODE_TOOL_NAME,
    input: options.input,
    gate: options.gate,
    signal: options.signal,
    ...(covered.length > 0 ? { batch: { tools: covered, dynamic: references.dynamic } } : {}),
  });
  if (denied) return denied;

  // The approval stands in for every covered call the script goes on to make;
  // anything else still asks for itself.
  if (covered.length > 0) {
    grantApprovalScope({
      sessionId: options.gate.sessionId,
      toolCallId: options.toolCallId,
      tools: covered,
      expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
    });
  }
  return undefined;
}

/** Whether the tool declares itself safe to run without asking. */
function isReadOnlyTool(pi: ExtensionAPI, toolName: string): boolean {
  const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
  return tool?.annotations?.readOnlyHint === true;
}

/**
 * The tools a script reaches that would each ask for approval on their own.
 *
 * A script whose source does not show what it reaches (a computed name, the
 * catalog) could call anything the session can, so every callable tool that
 * would ask is covered — the same reading a watcher's grant takes, and the card
 * says so. Command-aware `auto` tools stay out: their decision is made from the
 * command they are called with, which only exists at the call.
 */
function referencedCallsNeedingApproval(
  references: { keys: readonly string[]; dynamic: boolean },
  pi: ExtensionAPI,
  context: ToolPolicyContext,
): string[] {
  const callable = callableToolNames(pi);
  const covered = references.dynamic ? callable : resolveReferencedTools(references.keys, callable);
  return covered.filter((toolName) => resolveToolPolicy(toolName, context) === "ask");
}

/**
 * The tools a script may call, by Pi's own rule for `ctx.executeTool()`: the
 * active `direct` tools plus every registered `codemode`/`deferred` tool.
 * `codemode` itself is `model-only`, so it is never in the set.
 */
function callableToolNames(pi: ExtensionAPI): string[] {
  const active = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .filter(
      (tool) =>
        tool.exposure === "codemode" ||
        tool.exposure === "deferred" ||
        (tool.exposure === "direct" && active.has(tool.name)),
    )
    .map((tool) => tool.name);
}
