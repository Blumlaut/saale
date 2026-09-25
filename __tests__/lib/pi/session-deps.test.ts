import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * `buildSessionDeps` assembles a session's tool list from two sources: the
 * caller's own tools and the tools resolved from the user's config. Both end up
 * in the same `customTools` array, so both must carry the same wrappers — the
 * approval gate is applied here, and a tool that misses it executes without the
 * user ever being asked.
 */

const { mockResolveTools } = vi.hoisted(() => ({ mockResolveTools: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createBashTool: vi.fn(() => ({ name: "bash" })),
  createEditTool: vi.fn(() => ({ name: "edit" })),
  createReadTool: vi.fn(() => ({ name: "read" })),
  createWriteTool: vi.fn(() => ({ name: "write" })),
}));

vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: vi.fn().mockResolvedValue({
    modelRuntime: { getModel: vi.fn().mockReturnValue({ id: "model" }) },
  }),
}));

vi.mock("@/lib/pi/tool-registry", () => ({ resolveTools: mockResolveTools }));
vi.mock("@/lib/terminal/operations", () => ({ createTerminalOperations: vi.fn() }));
vi.mock("@/lib/terminal/client", () => ({ getTerminalHomeDir: () => "/home/user" }));
vi.mock("@/lib/github", () => ({ getGitHubEnv: vi.fn().mockResolvedValue({}) }));

import { buildSessionDeps } from "@/lib/pi/session";

function tool(name: string): ToolDefinition {
  return { name, label: name, description: "", parameters: {}, execute: vi.fn() } as never;
}

describe("buildSessionDeps", () => {
  const gate = vi.fn((t: ToolDefinition) => ({ ...t, name: `gated:${t.name}` }));

  beforeEach(() => {
    vi.clearAllMocks();
    gate.mockImplementation((t: ToolDefinition) => ({ ...t, name: `gated:${t.name}` }));
    mockResolveTools.mockImplementation(
      async (_userId: string, _sessionId: string, _enabled: unknown, options: unknown) => {
        const resolver = options as {
          wrapWithApproval?: (t: ToolDefinition) => ToolDefinition;
        };
        const resolved = tool("memory_search");
        return resolver.wrapWithApproval ? [resolver.wrapWithApproval(resolved)] : [resolved];
      },
    );
  });

  it("wraps caller-supplied tools with the same gate as resolved ones", async () => {
    const { allCustomTools } = await buildSessionDeps({
      userId: "user-1",
      sessionId: "session-1",
      customTools: [tool("caller_tool")],
      toolConfig: null,
      modelProvider: "custom",
      modelName: "model",
      wrapTool: gate,
    });

    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ name: "caller_tool" }));
    expect(allCustomTools.map((t) => t.name)).toEqual(["gated:caller_tool", "gated:memory_search"]);
  });

  it("leaves caller-supplied tools untouched when no gate is configured", async () => {
    const custom = tool("caller_tool");
    const { allCustomTools } = await buildSessionDeps({
      userId: "user-1",
      sessionId: "session-1",
      customTools: [custom],
      toolConfig: null,
      modelProvider: "custom",
      modelName: "model",
    });

    expect(gate).not.toHaveBeenCalled();
    expect(allCustomTools.map((t) => t.name)).toEqual(["caller_tool", "memory_search"]);
  });
});
