import { describe, it, expect } from "vitest";
import { resolveMcpToolPolicy, resolveToolPolicy } from "@/lib/pi/tool-policy";

/**
 * Every gate resolves a call's policy through here — the wrapper around Saale's
 * own tools, the MCP extension and the codemode gate — so these cases are what
 * keeps a tool from being gated on one path and running unapproved on another.
 */

const SERVER_POLICIES = {
  home_assistant: "ask" as const,
  docs: "allow" as const,
  legacy: "off" as const,
};

describe("resolveToolPolicy", () => {
  it("prefers the user's own policy", () => {
    expect(resolveToolPolicy("mail_send", { toolPolicies: { mail_send: "allow" } })).toBe("allow");
    expect(resolveToolPolicy("read", { toolPolicies: { read: "off" } })).toBe("off");
  });

  it("ignores a stored value it does not understand and uses the catalog default", () => {
    expect(resolveToolPolicy("mail_send", { toolPolicies: { mail_send: "banana" } })).toBe("ask");
    expect(resolveToolPolicy("read", { toolPolicies: null })).toBe("allow");
    expect(resolveToolPolicy("bash", { toolPolicies: null })).toBe("auto");
  });

  it("gives the codemode tool its catalog policy, so scripts can be blocked", () => {
    expect(resolveToolPolicy("codemode", { toolPolicies: null })).toBe("auto");
    expect(resolveToolPolicy("codemode", { toolPolicies: { codemode: "off" } })).toBe("off");
  });

  it("asks for a tool it has never heard of", () => {
    expect(resolveToolPolicy("some_future_tool", { toolPolicies: null })).toBe("ask");
    expect(resolveToolPolicy("some_future_tool", { toolPolicies: { bash: "off" } })).toBe("ask");
  });

  it("resolves an MCP tool through its server when the user has no policy for it", () => {
    const context = { toolPolicies: null, mcpServerPolicies: SERVER_POLICIES };

    expect(resolveToolPolicy("mcp__docs__search", context)).toBe("allow");
    expect(resolveToolPolicy("mcp__legacy__do", context)).toBe("off");
    // No server policy to fall back on: fail closed.
    expect(resolveToolPolicy("mcp__unconfigured__do", context)).toBe("ask");
    expect(resolveToolPolicy("mcp__docs__search", { toolPolicies: null })).toBe("ask");
  });

  it("prefers the user's policy for one MCP tool over its server's", () => {
    expect(
      resolveToolPolicy("mcp__docs__search", {
        toolPolicies: { mcp__docs__search: "ask" },
        mcpServerPolicies: SERVER_POLICIES,
      }),
    ).toBe("ask");
  });
});

describe("resolveMcpToolPolicy", () => {
  it("prefers the user's exact per-tool policy", () => {
    expect(
      resolveMcpToolPolicy({
        toolName: "mcp__docs__search",
        serverPolicies: SERVER_POLICIES,
        toolPolicies: { mcp__docs__search: "off" },
      }),
    ).toBe("off");
  });

  it("ignores a per-tool policy it does not understand", () => {
    expect(
      resolveMcpToolPolicy({
        toolName: "mcp__docs__search",
        serverPolicies: SERVER_POLICIES,
        toolPolicies: { mcp__docs__search: "yes" },
      }),
    ).toBe("allow");
  });

  it("falls back to the server's policy", () => {
    expect(
      resolveMcpToolPolicy({
        toolName: "mcp__legacy__do",
        serverPolicies: SERVER_POLICIES,
        toolPolicies: null,
      }),
    ).toBe("off");
  });

  it("asks when the server is unknown", () => {
    expect(
      resolveMcpToolPolicy({
        toolName: "mcp__unconfigured__do",
        serverPolicies: SERVER_POLICIES,
        toolPolicies: null,
      }),
    ).toBe("ask");
  });
});
