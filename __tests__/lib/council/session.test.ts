import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

const hoisted = vi.hoisted(() => ({
  createAgentSession: vi.fn(async () => ({ session: { id: "session-1" } })),
  bindExtensions: vi.fn(async () => {}),
  setActiveToolsByName: vi.fn(),
  getActiveToolNames: vi.fn(() => []),
}));

// The real SDK is kept (its `defineTool` is what builds the member's tools) and
// only the two things a unit test cannot run  creating a session and the
// transcript manager  are replaced.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: hoisted.createAgentSession,
    SessionManager: { inMemory: () => ({ kind: "in-memory" }) },
  };
});

vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: vi.fn(async () => ({
    modelRuntime: { getModel: vi.fn(() => ({ id: "model-1" })) },
  })),
}));

vi.mock("@/lib/pi/model-resolution", () => ({
  resolveModelForPurpose: vi.fn(async () => ({ provider: "anthropic", name: "claude-x" })),
}));

vi.mock("@/lib/pi/processing-state", () => ({
  createAgentResourceLoader: vi.fn(async (options: { prompt: string; cwd: string }) => ({
    kind: "loader",
    ...options,
  })),
  startSessionExtensions: vi.fn(async (session: any) => {
    await session.bindExtensions?.({});
  }),
}));

vi.mock("@/lib/pi/settings", () => ({
  createSessionSettings: vi.fn(() => ({ kind: "saale-settings" })),
}));

vi.mock("@/lib/pi/tool-registry", () => ({
  resolveTools: vi.fn(async () => [
    { name: "read" },
    { name: "write" },
    { name: "edit" },
    { name: "bash" },
    { name: "show_file" },
    { name: "chat_search" },
    { name: "web_search" },
  ]),
}));

vi.mock("@/lib/council/sandbox", () => ({
  createCouncilSandbox: vi.fn(() => ({
    identity: {
      key: "abcd1234",
      id: "council-abcd1234",
      path: "/workspaces/council-abcd1234",
    },
    home: "/workspaces/council-abcd1234",
    operations: {},
  })),
  councilSandboxTools: vi.fn(() => ({
    read: { name: "read" },
    write: { name: "write" },
    edit: { name: "edit" },
    bash: { name: "bash" },
  })),
}));

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { buildModelRuntime } from "@/lib/pi/models";
import { createAgentResourceLoader, startSessionExtensions } from "@/lib/pi/processing-state";
import { resolveTools } from "@/lib/pi/tool-registry";
import { createCouncilMemberSession } from "@/lib/council/session";
import type { CouncilToolContext } from "@/lib/council/tools";

const TOOL_CONTEXT: CouncilToolContext = {
  member: { id: "m1", name: "acorn" },
  members: [{ id: "m1", name: "acorn" }],
  post: vi.fn(async () => ({ seq: 1, wokeNames: [] })),
  read: vi.fn(async () => ({ messages: [], lastSeq: 0 })),
  vote: vi.fn(async () => ({ votes: 1, needed: 1, stopped: true })),
};

const OPTIONS = {
  userId: "user_123",
  councilId: "council_1",
  councilName: "Launch review",
  brief: "Decide whether the migration is safe.",
  orchestration: "parallel" as const,
  stopVoteThreshold: "majority" as const,
  members: [{ name: "acorn" }, { name: "blade" }],
  memberTargets: [
    { id: "m1", name: "acorn" },
    { id: "m2", name: "blade" },
  ],
  member: {
    id: "m1",
    name: "acorn",
    instructions: "You own the database side.",
    modelProvider: "anthropic",
    modelName: "claude-x",
    thinkingLevel: "high",
    toolConfig: { terminal: true, web: true },
  },
  councilToolConfig: { terminal: true },
  toolExposure: null,
  sandboxKey: "abcd1234",
  toolContext: TOOL_CONTEXT,
};

/** The options object the session was built with. */
function sessionOptions() {
  return vi.mocked(createAgentSession).mock.calls[0]![0] as any;
}

function toolNames(): string[] {
  return (sessionOptions().customTools as { name: string }[]).map((tool) => tool.name);
}

describe("createCouncilMemberSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveModelForPurpose).mockResolvedValue({
      provider: "anthropic",
      name: "claude-x",
    });
    vi.mocked(buildModelRuntime).mockResolvedValue({
      modelRuntime: { getModel: vi.fn(() => ({ id: "model-1" })) },
    } as any);
  });

  it("runs the member in its own sandbox, not in the user's home", async () => {
    const { sandbox } = await createCouncilMemberSession(OPTIONS);

    expect(sessionOptions().cwd).toBe("/workspaces/council-abcd1234");
    // The wrapper this deliberately does not use would have resolved the *user's*
    // workspace here; the sandbox key is what makes it a different directory.
    expect(sessionOptions().cwd).not.toContain("user_123");
    expect(sandbox.home).toBe("/workspaces/council-abcd1234");
  });

  it("builds the room prompt for this member, served from the sandbox cwd", async () => {
    await createCouncilMemberSession(OPTIONS);

    const loader = vi.mocked(createAgentResourceLoader).mock.calls[0]![0];
    expect(loader.cwd).toBe("/workspaces/council-abcd1234");
    expect(loader.prompt).toContain("You are acorn");
    expect(loader.prompt).toContain("Decide whether the migration is safe.");
    expect(loader.prompt).not.toContain("@acorn");
  });

  it("keeps Pi's built-in file tools out, so only sandboxed ones run", async () => {
    await createCouncilMemberSession(OPTIONS);
    const options = sessionOptions();
    expect(options.noTools).toBe("builtin");
    expect(options.settingsManager).toEqual({ kind: "saale-settings" });
    expect(options.sessionManager).toEqual({ kind: "in-memory" });
  });

  it("gives the member the room tools and its selected categories", async () => {
    await createCouncilMemberSession(OPTIONS);
    const names = toolNames();
    for (const name of ["council_post", "council_read", "council_vote_stop", "read", "bash"]) {
      expect(names).toContain(name);
    }
    expect(names).toContain("web_search");
    expect(vi.mocked(resolveTools)).toHaveBeenCalledWith(
      "user_123",
      "council_1",
      expect.objectContaining({ terminal: true, web: true }),
      expect.objectContaining({ createSandboxScopedTools: expect.any(Function) }),
    );
  });

  it("hands the sandbox to the tool resolver instead of the user's workspace tools", async () => {
    await createCouncilMemberSession(OPTIONS);
    const injected = vi.mocked(resolveTools).mock.calls[0]![3].createSandboxScopedTools;
    const tools = await injected("user_123", "council_1");
    expect(Object.keys(tools)).toEqual(["read", "write", "edit", "bash"]);
  });

  it("drops the tools that would reach the owner's own data", async () => {
    const { session } = await createCouncilMemberSession(OPTIONS);
    const names = toolNames();
    // `show_file` reads a file the owner uploaded to a chat; the chat-history
    // tools belong to a conversation the council is not part of.
    expect(names).not.toContain("show_file");
    expect(names).not.toContain("chat_search");
    expect(session).toBeTruthy();
  });

  it("activates the session's extensions, which is what enables codemode", async () => {
    await createCouncilMemberSession(OPTIONS);
    expect(startSessionExtensions).toHaveBeenCalledTimes(1);
  });

  it("passes the member's thinking level to Pi", async () => {
    await createCouncilMemberSession(OPTIONS);
    expect(sessionOptions().thinkingLevel).toBe("high");
  });

  it("leaves the level to Pi for a member with no preference", async () => {
    await createCouncilMemberSession({
      ...OPTIONS,
      member: { ...OPTIONS.member, thinkingLevel: "default" },
    });
    expect(sessionOptions().thinkingLevel).toBeUndefined();
  });

  it("uses the member's model reference and reports it", async () => {
    const { modelLabel } = await createCouncilMemberSession(OPTIONS);
    expect(resolveModelForPurpose).toHaveBeenCalledWith("user_123", "chat", "anthropic:claude-x");
    expect(modelLabel).toBe("anthropic:claude-x");
  });

  it("lets a member's own tool selection override the council's", async () => {
    await createCouncilMemberSession({
      ...OPTIONS,
      councilToolConfig: { terminal: true, web: true },
      member: { ...OPTIONS.member, toolConfig: { terminal: true, web: false } },
    });
    expect(vi.mocked(resolveTools).mock.calls[0]![2]).toMatchObject({ web: false, terminal: true });
  });

  it("inherits the council's selection when the member has none", async () => {
    await createCouncilMemberSession({
      ...OPTIONS,
      councilToolConfig: { terminal: true, web: true },
      member: { ...OPTIONS.member, toolConfig: null },
    });
    expect(vi.mocked(resolveTools).mock.calls[0]![2]).toMatchObject({ web: true });
  });

  it("defaults to the workspace alone, not to a chat's tool defaults", async () => {
    await createCouncilMemberSession({
      ...OPTIONS,
      councilToolConfig: null,
      member: { ...OPTIONS.member, toolConfig: null },
    });

    // A council runs unattended; anything reaching the owner's own accounts
    // (Telegram, mail, memory, tasks) is a per-council decision.
    expect(vi.mocked(resolveTools).mock.calls[0]![2]).toMatchObject({
      terminal: true,
      telegram: false,
      email: false,
      memory: false,
      tasks: false,
      calendar: false,
      infra: false,
      settings: false,
    });
  });

  it("refuses to build a member with no model at all", async () => {
    vi.mocked(resolveModelForPurpose).mockResolvedValue(undefined);
    await expect(createCouncilMemberSession(OPTIONS)).rejects.toThrow(
      /No model for council member "acorn"/,
    );
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("refuses to build a member whose model is no longer available", async () => {
    vi.mocked(buildModelRuntime).mockResolvedValue({
      modelRuntime: { getModel: vi.fn(() => undefined) },
    } as any);
    await expect(createCouncilMemberSession(OPTIONS)).rejects.toThrow(
      /anthropic:claude-x is not available/,
    );
    expect(createAgentSession).not.toHaveBeenCalled();
  });
});
