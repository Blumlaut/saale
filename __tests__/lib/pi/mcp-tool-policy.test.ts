import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIsAutoApproveActive = vi.fn();
vi.mock("@/lib/pi/auto-approve", () => ({
  isAutoApproveActive: (...args: unknown[]) => mockIsAutoApproveActive(...args),
}));

const mockRequestToolApproval = vi.fn();
vi.mock("@/lib/pi/tool-approval-gate", () => ({
  requestToolApproval: (...args: unknown[]) => mockRequestToolApproval(...args),
}));

import { createMcpToolPolicyExtension, resolveMcpToolPolicy } from "@/lib/pi/mcp-tool-policy";

const SERVER_POLICIES = {
  home_assistant: "ask" as const,
  docs: "allow" as const,
  legacy: "off" as const,
};

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

/** Capture the `tool_call` handler the extension registers. */
function captureHandler() {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const pi = {
    on: (event: string, h: typeof handler) => {
      if (event === "tool_call") handler = h;
      return () => {};
    },
  };

  const extension = createMcpToolPolicyExtension({
    userId: "user-1",
    sessionId: "session-1",
    serverPolicies: SERVER_POLICIES,
    toolPolicies: { mcp__docs__search: "ask" },
    emitApprovalRequest: vi.fn(),
  });
  extension(pi as never);

  if (!handler) throw new Error("the extension registered no tool_call handler");
  return handler;
}

describe("MCP tool call gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAutoApproveActive.mockResolvedValue(false);
  });

  it("ignores tools that are not MCP tools", async () => {
    const handler = captureHandler();
    const result = await handler(
      { toolName: "bash", toolCallId: "call-1", input: { command: "ls" } },
      { signal: undefined },
    );
    expect(result).toBeUndefined();
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
  });

  it("blocks a tool whose server is off, without asking", async () => {
    const handler = captureHandler();
    const result = await handler(
      { toolName: "mcp__legacy__do", toolCallId: "call-1", input: {} },
      { signal: undefined },
    );
    expect(result).toMatchObject({ block: true });
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
  });

  it("lets an allowed tool run", async () => {
    const handler = captureHandler();
    const result = await handler(
      { toolName: "mcp__docs__read", toolCallId: "call-1", input: {} },
      { signal: undefined },
    );
    expect(result).toBeUndefined();
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
  });

  it("runs an asking tool once the user approves it", async () => {
    mockRequestToolApproval.mockResolvedValue("approved");
    const handler = captureHandler();
    const result = await handler(
      {
        toolName: "mcp__home_assistant__HassTurnOn",
        toolCallId: "call-7",
        input: { entity: "light" },
      },
      { signal: undefined },
    );

    expect(result).toBeUndefined();
    expect(mockRequestToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "call-7",
        toolName: "mcp__home_assistant__HassTurnOn",
        userId: "user-1",
        sessionId: "session-1",
        args: { entity: "light" },
      }),
    );
  });

  it("blocks an asking tool the user denied", async () => {
    mockRequestToolApproval.mockResolvedValue("denied");
    const handler = captureHandler();
    const result = await handler(
      { toolName: "mcp__home_assistant__HassTurnOn", toolCallId: "call-7", input: {} },
      { signal: undefined },
    );
    expect(result).toMatchObject({ block: true });
  });

  it("blocks an asking tool when the run was aborted while waiting", async () => {
    mockRequestToolApproval.mockResolvedValue("aborted");
    const handler = captureHandler();
    const result = await handler(
      { toolName: "mcp__home_assistant__HassTurnOn", toolCallId: "call-7", input: {} },
      { signal: undefined },
    );
    expect(result).toMatchObject({ block: true });
  });

  it("auto-approves everything while /stfu is active, but never a blocked server", async () => {
    mockIsAutoApproveActive.mockResolvedValue(true);
    const handler = captureHandler();

    const asked = await handler(
      { toolName: "mcp__home_assistant__HassTurnOn", toolCallId: "call-1", input: {} },
      { signal: undefined },
    );
    expect(asked).toBeUndefined();
    expect(mockRequestToolApproval).not.toHaveBeenCalled();

    const blocked = await handler(
      { toolName: "mcp__legacy__do", toolCallId: "call-2", input: {} },
      { signal: undefined },
    );
    expect(blocked).toMatchObject({ block: true });
  });
});
