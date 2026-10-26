/**
 * Which approval policy governs a call.
 *
 * One answer for the session's `tool_call` gate and for the tool list the model
 * is given: a tool whose policy is `off` is neither declared nor callable, and
 * the gate answers the same `off` for the tools registered after the session
 * was built (a plugin's, an MCP server's).
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
import { findToolInfo, isToolPolicy, type ToolPolicy } from "./tool-infos";

/** The user context a policy is resolved against. */
export interface ToolPolicyContext {
  /** The user's per-tool policies (`AppSettings.toolPolicies`), by tool name. */
  toolPolicies: Record<string, string> | null | undefined;
  /** Policy per MCP server, keyed by `mcpNameKey(name)`. */
  mcpServerPolicies?: Record<string, McpToolPolicy>;
}

/**
 * The policy that governs one MCP tool call: the user's policy for that exact
 * tool (`mcp__server__tool`), else the server's, else `ask`. fail closed, like
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

/** What is known about a tool the catalog does not describe. */
export interface ToolIntrinsicAccess {
  /**
   * The tool declares itself read-only (Pi's `readOnlyHint`, the MCP
   * annotation of the same name). A read is harmless, so it runs.
   */
  readOnly: boolean;
}

/**
 * The policy that governs one call, whichever gate is asking.
 *
 * A tool Saale ships follows its catalog default, which is where a tool's reach
 * is decided (read file contents. `allow`; run a shell command. `auto`). A tool
 * nobody configured. a plugin's, say, or one an MCP server adds later. has no
 * entry, so its own declaration is the evidence: read-only runs, and anything
 * that can write or reach outside the workspace asks. `ask` is the answer when
 * there is no evidence at all.
 */
export function resolveToolPolicy(
  toolName: string,
  context: ToolPolicyContext,
  access?: ToolIntrinsicAccess,
): ToolPolicy {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) {
    return resolveMcpToolPolicy({
      toolName,
      serverPolicies: context.mcpServerPolicies ?? {},
      toolPolicies: context.toolPolicies,
    });
  }

  const policy = context.toolPolicies?.[toolName];
  if (isToolPolicy(policy)) return policy;

  const known = findToolInfo(toolName);
  if (known) return known.defaultPolicy;

  return access?.readOnly ? "allow" : "ask";
}
