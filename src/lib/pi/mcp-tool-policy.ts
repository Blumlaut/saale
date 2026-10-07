/**
 * Approval gate for MCP tools.
 *
 * Saale's tools are wrapped with `wrapWithApprovalGate` when the session is
 * created, but MCP tools are registered later by Pi's MCP extension — they
 * never pass through that wrapper. Without this, a user's approval policies
 * would silently not apply to the one tool set that reaches third-party
 * services: `ask` and `off` would be ignored and every call would run.
 *
 * The gate therefore runs as a Pi extension on the `tool_call` event, which is
 * the pipeline MCP calls (direct or from a codemode script) go through. Policy
 * resolution is shared with every other gate (see `tool-policy.ts`).
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MCP_TOOL_PREFIX, type McpToolPolicy } from "@/lib/mcp/shared";
import { isApprovalScopeGranted } from "./approval-scope";
import { isAutoApproveActive } from "./auto-approve";
import { requestToolApproval, type ApprovalRequest } from "./tool-approval-gate";
import { resolveMcpToolPolicy } from "./tool-policy";

export function createMcpToolPolicyExtension(options: {
  userId: string;
  sessionId: string;
  /** Approval policy per server, keyed by `mcpNameKey(name)`. */
  serverPolicies: Record<string, McpToolPolicy>;
  /** The user's per-tool policies (`AppSettings.toolPolicies`). */
  toolPolicies: Record<string, string> | null | undefined;
  emitApprovalRequest: (request: ApprovalRequest) => void;
}): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const toolName = event.toolName;
      if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;

      const policy = resolveMcpToolPolicy({
        toolName,
        serverPolicies: options.serverPolicies,
        toolPolicies: options.toolPolicies,
      });

      if (policy === "off") {
        return { block: true, reason: `MCP tool "${toolName}" is disabled.` };
      }

      // Auto-approve mode (/stfu) accepts everything that would otherwise
      // ask — never a tool the user turned off.
      if (await isAutoApproveActive(options.userId)) return undefined;
      if (policy === "allow") return undefined;

      // The user already approved this call as part of a script that announced
      // it — asking again would undo the one-click decision.
      if (
        isApprovalScopeGranted({
          sessionId: options.sessionId,
          toolCallId: event.toolCallId,
          toolName,
        })
      ) {
        return undefined;
      }

      const outcome = await requestToolApproval({
        toolCallId: event.toolCallId,
        toolName,
        userId: options.userId,
        sessionId: options.sessionId,
        args: event.input,
        emitApprovalRequest: options.emitApprovalRequest,
        signal: ctx.signal,
      });

      if (outcome === "aborted") {
        return { block: true, reason: `The run was stopped while "${toolName}" awaited approval.` };
      }
      if (outcome !== "approved") {
        return {
          block: true,
          reason: `MCP tool "${toolName}" was denied by the user (approval timed out or was rejected).`,
        };
      }
      return undefined;
    });
  };
}
