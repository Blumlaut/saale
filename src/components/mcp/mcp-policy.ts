import type { McpToolPolicy } from "@/lib/mcp/shared";
import type { ToolPolicy } from "@/lib/pi/tool-infos";

/**
 * How a server's tools are approved, whichever control offers it.
 *
 * One list for the server's own policy and for a single tool of it: the same
 * three answers mean the same thing in both places.
 */
export const MCP_POLICY_OPTIONS: readonly {
  value: McpToolPolicy;
  label: string;
  hint: string;
}[] = [
  { value: "ask", label: "Ask", hint: "Ask for approval before running a tool" },
  { value: "allow", label: "Allow", hint: "Run tools automatically" },
  { value: "off", label: "Block", hint: "Never run tools from this server" },
];

/** A stored answer as its row names it, including "no answer of its own". */
export const MCP_POLICY_LABELS: Record<string, string> = {
  ask: "Ask",
  allow: "Allow",
  off: "Blocked",
  clear: "Follow server",
};

/** The hint under a policy control, for the value it holds. */
export function mcpPolicyHint(policy: McpToolPolicy): string | undefined {
  return MCP_POLICY_OPTIONS.find((option) => option.value === policy)?.hint;
}

/**
 * The `toolPolicies` column with one tool's answer set, or taken back out when
 * `policy` is null so the tool follows its server again.
 */
export function withToolPolicy(
  policies: Record<string, ToolPolicy> | null | undefined,
  toolName: string,
  policy: ToolPolicy | null,
): Record<string, ToolPolicy> | null {
  const next = { ...policies };
  if (policy) next[toolName] = policy;
  else delete next[toolName];
  return Object.keys(next).length > 0 ? next : null;
}
