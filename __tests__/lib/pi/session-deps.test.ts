import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * `buildSessionDeps` assembles a session's tool list from two sources: the
 * caller's own tools and the tools resolved from the user's config. Both end up
 * in the same `customTools` array, so both must carry the same wrappers  the
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
vi.mock("@/lib/sandbox/operations", () => ({ createSandboxOperations: vi.fn() }));
vi.mock("@/lib/sandbox/env", () => ({ resolveSandboxEnv: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/sandbox/workspace", () => ({
  userWorkspacePath: (userId: string) => `/workspaces/user-${userId}`,
  workspaceOwner: () => null,
}));

import { buildSessionDeps } from "@/lib/pi/session";

function tool(name: string): ToolDefinition {
  return { name, label: name, description: "", parameters: {}, execute: vi.fn() } as never;
}

describe("buildSessionDeps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTools.mockResolvedValue([tool("memory_search")]);
  });

  it("registers caller-supplied tools alongside the resolved ones", async () => {
    const { allCustomTools } = await buildSessionDeps({
      userId: "user-1",
      sessionId: "session-1",
      customTools: [tool("caller_tool")],
      toolConfig: null,
      modelProvider: "custom",
      modelName: "model",
    });

    // Gating happens on `tool_call`, so no definition is rewritten here.
    expect(allCustomTools.map((t) => t.name)).toEqual(["caller_tool", "memory_search"]);
  });

  it("enables a category the stored config predates", async () => {
    // Old rows hold a config written before a category existed, and the row is
    // sparse once normalized. A missing key must still resolve to the current
    // registry default, or a newly added tool set is silently off for everyone
    // whose settings were saved earlier.
    let enabled: Record<string, boolean> | undefined;
    mockResolveTools.mockImplementationOnce(
      async (_userId: string, _sessionId: string, config: unknown) => {
        enabled = config as Record<string, boolean>;
        return [tool("memory_search")];
      },
    );

    await buildSessionDeps({
      userId: "user-1",
      sessionId: "session-1",
      customTools: [],
      toolConfig: { terminal: true, email: false },
      modelProvider: "custom",
      modelName: "model",
    });

    expect(enabled).toMatchObject({ terminal: true, email: false, settings: true });
  });
});
