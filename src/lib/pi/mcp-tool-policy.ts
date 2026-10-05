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
 * resolution mirrors `createToolApprovalGate`:
 *
 * 1. the user's per-tool policy for the exact tool name (`mcp__server__tool`),
 * 2. otherwise the server's own policy (Saale's MCP settings),
 * 3. otherwise `ask` — fail closed, like any other unknown tool.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  isMcpToolPolicy,
  mcpServerFromToolName,
  MCP_TOOL_PREFIX,
  type McpToolPolicy,
} from "@/lib/mcp/shared";
import { isAutoApproveActive } from "./auto-approve";
import { requestToolApproval, type ApprovalRequest } from "./tool-approval-gate";

/** The policy that governs one MCP tool call. */
export function resolveMcpToolPolicy(options: {
  toolName: string;
  serverPolicies: Record<string, McpToolPolicy>;
  toolPolicies: Record<string, string> | null | undefined;
}): McpToolPolicy {
  const explicit = options.toolPolicies?.[options.toolName];
  if (isMcpToolPolicy(explicit)) return explicit;

  const server = mcpServerFromToolName(options.toolName);
  const serverPolicy = server ? options.serverPolicies[server] : undefined;
  return serverPolicy ?? "ask";
}

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
