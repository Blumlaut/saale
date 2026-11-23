import type { McpToolPolicy } from "@/lib/mcp/shared";

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

/** The same setting as a row names it: a policy has one word per place. */
export const MCP_POLICY_LABELS: Record<string, string> = {
  ask: "Ask",
  allow: "Allow",
  off: "Blocked",
};

/** The hint under a policy control, for the value it holds. */
export function mcpPolicyHint(policy: McpToolPolicy): string | undefined {
  return MCP_POLICY_OPTIONS.find((option) => option.value === policy)?.hint;
}
