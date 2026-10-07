/**
 * Which approval policy governs a call.
 *
 * One answer for every gate that has to give one. Saale gates tool calls in
 * three places — the wrapper around its own tools, the extension that catches
 * MCP tools, and the gate on `codemode` — and they must agree: a tool that is
 * gated on one path and runs unapproved on another is the bug this module
 * exists to make impossible.
 *
 * The user's own per-tool policy wins. Without one, an MCP tool follows its
 * server's policy and a tool Saale ships follows its catalog default.
 */

import {
  isMcpToolPolicy,
  mcpServerFromToolName,
  MCP_TOOL_PREFIX,
  type McpToolPolicy,
} from "@/lib/mcp/shared";
import { getDefaultPolicy, isToolPolicy, type ToolPolicy } from "./tool-infos";

/** The user context a policy is resolved against. */
export interface ToolPolicyContext {
  /** The user's per-tool policies (`AppSettings.toolPolicies`), by tool name. */
  toolPolicies: Record<string, string> | null | undefined;
  /** Policy per MCP server, keyed by `mcpNameKey(name)`. */
  mcpServerPolicies?: Record<string, McpToolPolicy>;
}

/**
 * The policy that governs one MCP tool call: the user's policy for that exact
 * tool (`mcp__server__tool`), else the server's, else `ask` — fail closed, like
 * any other unknown tool.
 */
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

/** The policy that governs one call, whichever gate is asking. */
export function resolveToolPolicy(toolName: string, context: ToolPolicyContext): ToolPolicy {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) {
    return resolveMcpToolPolicy({
      toolName,
      serverPolicies: context.mcpServerPolicies ?? {},
      toolPolicies: context.toolPolicies,
    });
  }

  const policy = context.toolPolicies?.[toolName];
  return isToolPolicy(policy) ? policy : getDefaultPolicy(toolName);
}
