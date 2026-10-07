/**
 * Approval gate for `codemode`.
 *
 * `codemode` is registered by Pi's extension at `session_start` — after
 * `wrapTool` has already run over the session's tools — so neither its own call
 * nor the calls its script makes pass through the tool wrapper. This gate runs
 * on the `tool_call` event instead, which both go through.
 *
 * A script's calls each carry their own policy, so a batch of them would
 * otherwise put one card in front of the user per call. They are one decision:
 * the user reads the script once. So the script is the approval unit — one card
 * listing the calls that would ask on their own, and one click that stands in
 * for all of them (see `approval-scope.ts`).
 *
 * What that card covers is read from the script's source, and only calls that
 * would ask on their own are in it:
 *
 * - a tool whose policy is `ask` is listed and covered by the approval;
 * - a command-aware `auto` tool (`bash`, `infra_exec`) is not, because its
 *   decision is made from the command it is called with — which exists only at
 *   the call, where a card can show it;
 * - a tool the script reaches by a computed name is not in the list either, and
 *   asks for itself. The card says so, so an approval is never mistaken for a
 *   blanket one.
 *
 * The gate also applies the user's own policy for `codemode` itself: `off`
 * blocks scripts outright (a decision no other gate could make, since nothing
 * else sees them), `ask` always asks, and `auto` — the default — asks only when
 * the script reaches a tool that would ask, so reading a mailbox in a script
 * costs no click at all.
 */

import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { McpToolPolicy } from "@/lib/mcp/shared";
import { grantApprovalScope, releaseApprovalScope } from "./approval-scope";
import { isAutoApproveActive } from "./auto-approve";
import { readScriptToolReferences } from "./codemode-script";
import {
  APPROVAL_TIMEOUT_MS,
  requestToolApproval,
  type ApprovalRequest,
} from "./tool-approval-gate";
import { resolveToolPolicy, type ToolPolicyContext } from "./tool-policy";
import { CODEMODE_TOOL_NAME } from "./tool-infos";

export function createCodemodeApprovalExtension(options: {
  userId: string;
  sessionId: string;
  /** The user's per-tool policies (`AppSettings.toolPolicies`). */
  toolPolicies: Record<string, string> | null | undefined;
  /** Policy per MCP server, so a script's MCP calls resolve like direct ones. */
  mcpServerPolicies?: Record<string, McpToolPolicy>;
  emitApprovalRequest: (request: ApprovalRequest) => void;
}): ExtensionFactory {
  const context: ToolPolicyContext = {
    toolPolicies: options.toolPolicies,
    ...(options.mcpServerPolicies ? { mcpServerPolicies: options.mcpServerPolicies } : {}),
  };

  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      // A script cannot start a script, so a nested `codemode` call does not
      // exist; this handler owns the model-issued call only.
      if (event.toolName !== CODEMODE_TOOL_NAME || event.parentToolCallId) return undefined;

      const policy = resolveToolPolicy(CODEMODE_TOOL_NAME, context);

      // Disabled stays disabled: not even auto-approve mode (/stfu) re-enables
      // a tool the user turned off.
      if (policy === "off") {
        return {
          block: true,
          reason: `Running scripts is disabled ('${CODEMODE_TOOL_NAME}' is set to Block).`,
        };
      }
      // Allowed: the script runs as one step, and every call it makes follows
      // its own policy — that is what the other gates are for.
      if (policy === "allow") return undefined;

      if (await isAutoApproveActive(options.userId)) return undefined;

      const code = typeof event.input.code === "string" ? event.input.code : "";
      const references = readScriptToolReferences(code);
      const covered = referencedCallsNeedingApproval(references.keys, pi, context);

      // "auto": the script is only a decision to make when it reaches something
      // that would ask on its own.
      if (policy === "auto" && covered.length === 0) return undefined;

      const outcome = await requestToolApproval({
        toolCallId: event.toolCallId,
        toolName: CODEMODE_TOOL_NAME,
        userId: options.userId,
        sessionId: options.sessionId,
        args: event.input,
        emitApprovalRequest: options.emitApprovalRequest,
        signal: ctx.signal,
        ...(covered.length > 0 ? { batch: { tools: covered, dynamic: references.dynamic } } : {}),
      });

      if (outcome === "aborted") {
        return { block: true, reason: "The run was stopped while the script awaited approval." };
      }
      if (outcome !== "approved") {
        return {
          block: true,
          reason: "The script was denied by the user (approval timed out or was rejected).",
        };
      }

      // The approval stands in for every covered call the script goes on to
      // make; anything else still asks for itself.
      if (covered.length > 0) {
        grantApprovalScope({
          sessionId: options.sessionId,
          toolCallId: event.toolCallId,
          tools: covered,
          expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
        });
      }
      return undefined;
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

/**
 * The tools a script reaches that would each ask for approval on their own.
 *
 * Command-aware `auto` tools are left out: their decision is made from the
 * command they are called with, which only exists at the call.
 */
function referencedCallsNeedingApproval(
  keys: readonly string[],
  pi: ExtensionAPI,
  context: ToolPolicyContext,
): string[] {
  return resolveReferencedTools(keys, callableToolNames(pi)).filter(
    (toolName) => resolveToolPolicy(toolName, context) === "ask",
  );
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

/**
 * Tool names the script's keys name.
 *
 * A key is the tool's codemode identifier (`mail_send`, `mcp__docs__search`) or
 * its raw name (`tools["my-tool"]`), and one string can be both — `my-tool`
 * becomes the identifier `my_tool`, which another tool may already be called —
 * so a key resolves to every name it could mean. Covering a name the script
 * never calls costs nothing; missing one it does call is what puts a call the
 * user already approved back in front of them.
 */
function resolveReferencedTools(keys: readonly string[], callable: readonly string[]): string[] {
  const namesByKey = new Map<string, string[]>();
  for (const name of callable) {
    for (const key of new Set([name, toCodemodeIdentifier(name)])) {
      const names = namesByKey.get(key);
      if (!names) namesByKey.set(key, [name]);
      else if (!names.includes(name)) names.push(name);
    }
  }

  const resolved = new Set<string>();
  for (const key of keys) {
    for (const name of namesByKey.get(key) ?? []) resolved.add(name);
  }
  return [...resolved];
}
