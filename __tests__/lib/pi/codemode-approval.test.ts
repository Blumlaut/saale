import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIsAutoApproveActive = vi.fn();
vi.mock("@/lib/pi/auto-approve", () => ({
  isAutoApproveActive: (...args: unknown[]) => mockIsAutoApproveActive(...args),
}));

const mockRequestToolApproval = vi.fn();
vi.mock("@/lib/pi/tool-approval-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pi/tool-approval-gate")>();
  return {
    ...actual,
    requestToolApproval: (...args: unknown[]) => mockRequestToolApproval(...args),
  };
});

import { grantApprovalScope, isApprovalScopeGranted } from "@/lib/pi/approval-scope";
import { createCodemodeApprovalExtension } from "@/lib/pi/codemode-approval";
import type { ApprovalBatch } from "@/lib/pi/tool-approval-gate";

/** A tool the session has, as the extension sees it in the registry. */
type RegistryTool = { name: string; exposure?: string };

/** The tools every test's registry has: two that ask, one that is allowed. */
const REGISTRY: RegistryTool[] = [
  { name: "mail_send" },
  { name: "mail_search" },
  { name: "task_delete" },
];

/**
 * Unique ids per test: a scope grant outlives the call that created it, so a
 * repeated id would let one test's grant cover the next test's calls.
 */
let sequence = 0;
function uniqueId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: Record<string, unknown>;
}

interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: Record<string, unknown>;
  content: unknown[];
  isError: boolean;
}

function setup(
  options: {
    tools?: RegistryTool[];
    active?: string[];
    toolPolicies?: Record<string, string> | null;
    mcpServerPolicies?: Record<string, "ask" | "allow" | "off">;
  } = {},
) {
  const handlers: Record<string, (event: never, ctx: never) => Promise<unknown> | unknown> = {};
  const tools = options.tools ?? [];
  const pi = {
    on: (event: string, handler: never) => {
      handlers[event] = handler;
      return () => {};
    },
    getAllTools: () =>
      tools.map((tool) => ({ name: tool.name, exposure: tool.exposure ?? "direct" })),
    // A session's resolved tools are active, which is what makes a direct tool
    // callable; `active` overrides it for the case where one is switched off.
    getActiveTools: () => options.active ?? tools.map((tool) => tool.name),
  };

  const sessionId = uniqueId("session");
  createCodemodeApprovalExtension({
    userId: "user-1",
    sessionId,
    toolPolicies: options.toolPolicies ?? null,
    ...(options.mcpServerPolicies ? { mcpServerPolicies: options.mcpServerPolicies } : {}),
    emitApprovalRequest: vi.fn(),
  })(pi as never);

  const onToolCall = handlers["tool_call"];
  const onToolResult = handlers["tool_result"];
  if (!onToolCall) throw new Error("the extension registered no tool_call handler");

  return {
    sessionId,
    /** Run the gate over a script the model submitted. */
    script: async (code: string, toolCallId = uniqueId("call")) =>
      (await onToolCall(
        { toolName: "codemode", toolCallId, input: { code } } as never,
        { signal: undefined } as never,
      )) as { block?: boolean; reason?: string } | undefined,
    /** Run the gate over an arbitrary tool call. */
    onToolCall: (event: Partial<ToolCallEvent>) =>
      onToolCall(
        { toolName: "codemode", toolCallId: uniqueId("call"), input: {}, ...event } as never,
        { signal: undefined } as never,
      ) as Promise<{ block?: boolean; reason?: string } | undefined>,
    /** Finish a tool call, as Pi does after it returns. */
    onToolResult: (event: Partial<ToolResultEvent>) =>
      onToolResult!(
        {
          toolName: "codemode",
          toolCallId: "call-x",
          input: {},
          content: [],
          isError: false,
          ...event,
        } as never,
        {} as never,
      ),
    /** What the card offered to cover, on the request at `index`. */
    batch: (index = 0): ApprovalBatch | undefined =>
      (mockRequestToolApproval.mock.calls[index]?.[0] as { batch?: ApprovalBatch } | undefined)
        ?.batch,
    /** The request the gate put to the user. */
    request: (index = 0) =>
      mockRequestToolApproval.mock.calls[index]?.[0] as { toolName: string; toolCallId: string },
    granted: (sessionId: string, toolCallId: string, toolName: string) =>
      isApprovalScopeGranted({ sessionId, toolCallId: `${toolCallId}/1`, toolName }),
  };
}

describe("codemode approval gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAutoApproveActive.mockResolvedValue(false);
    mockRequestToolApproval.mockResolvedValue("approved");
  });

  it("runs a script that reaches no tool needing approval, without asking", async () => {
    const { script } = setup({ tools: REGISTRY });

    await expect(
      script("const r = await tools.mail_search({ query: 'x' }); return r;"),
    ).resolves.toBeUndefined();
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
  });

  it("ignores a script's nested calls and any tool that is not codemode", async () => {
    const { onToolCall } = setup({ tools: REGISTRY });

    await expect(
      onToolCall({ toolCallId: "parent/1", parentToolCallId: "parent" }),
    ).resolves.toBeUndefined();
    await expect(onToolCall({ toolName: "bash" })).resolves.toBeUndefined();
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
  });

  it("asks once for every call the script announced, and covers them", async () => {
    const { script, batch, request, granted, sessionId } = setup({ tools: REGISTRY });
    const toolCallId = uniqueId("call");

    const code = [
      "const a = await tools.mail_search({ query: 'invoice' });",
      "await tools.task_delete({ taskId: a[0].id });",
      "await tools.mail_send({ to, subject });",
      "await tools.task_delete({ taskId: a[1].id });",
    ].join("\n");

    await expect(script(code, toolCallId)).resolves.toBeUndefined();

    expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    expect(request().toolName).toBe("codemode");
    expect(request().toolCallId).toBe(toolCallId);
    // The calls that would each ask on their own  not the allowed one, and a
    // tool reached twice is listed once.
    expect(batch()).toEqual({ tools: ["task_delete", "mail_send"], dynamic: false });

    expect(granted(sessionId, toolCallId, "task_delete")).toBe(true);
    expect(granted(sessionId, toolCallId, "mail_send")).toBe(true);
    // A tool the script did not announce is not covered by its approval.
    expect(granted(sessionId, toolCallId, "mail_delete")).toBe(false);
  });

  it("leaves a tool the user blocked out of the approval, so it cannot ride along", async () => {
    const { script, batch } = setup({ tools: REGISTRY, toolPolicies: { task_delete: "off" } });

    await script("await tools.mail_send({}); await tools.task_delete({});");

    expect(batch()?.tools).toEqual(["mail_send"]);
  });

  it("ignores a tool the session cannot call", async () => {
    // A `direct` tool is callable only while active, so a script naming one that
    // is switched off reaches nothing and must not widen the approval.
    const { script, batch } = setup({
      tools: [{ name: "mail_send" }, { name: "bash" }],
      active: ["read", "mail_send"],
    });

    await script("await tools.bash({ command: 'ls' }); await tools.mail_send({});");

    expect(batch()?.tools).toEqual(["mail_send"]);
  });

  it("covers a script's MCP call by the server's policy", async () => {
    const tools: RegistryTool[] = [
      { name: "mcp__docs__search", exposure: "codemode" },
      { name: "mcp__status__read", exposure: "codemode" },
    ];
    const { script, batch } = setup({
      tools,
      mcpServerPolicies: { docs: "ask", status: "allow" },
    });

    await script("await tools.mcp__docs__search({ q: 'x' }); await tools.mcp__status__read({});");

    expect(batch()?.tools).toEqual(["mcp__docs__search"]);
  });

  it("blocks the script outright when codemode is set to Block", async () => {
    const { script } = setup({ tools: REGISTRY, toolPolicies: { codemode: "off" } });

    const result = await script("await tools.mail_send({});");
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("disabled");
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
  });

  it("blocks the script even while auto-approve mode is on", async () => {
    mockIsAutoApproveActive.mockResolvedValue(true);
    const { script } = setup({ tools: REGISTRY, toolPolicies: { codemode: "off" } });

    await expect(script("await tools.mail_send({});")).resolves.toMatchObject({ block: true });
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
  });

  it("always asks when codemode is set to Ask, even for a read-only script", async () => {
    const { script, batch } = setup({ tools: REGISTRY, toolPolicies: { codemode: "ask" } });

    await script("return await tools.mail_search({ query: 'x' });");

    expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    expect(batch()).toBeUndefined();
  });

  it("runs the script unattended when codemode is set to Allow", async () => {
    const { script, granted, sessionId } = setup({
      tools: REGISTRY,
      toolPolicies: { codemode: "allow" },
    });
    const toolCallId = uniqueId("call");

    await expect(script("await tools.mail_send({});", toolCallId)).resolves.toBeUndefined();

    // Allow is about the script as a step: the calls it makes still answer to
    // their own policies, so nothing is covered by it.
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
    expect(granted(sessionId, toolCallId, "mail_send")).toBe(false);
  });

  it("runs the script while auto-approve mode is on", async () => {
    mockIsAutoApproveActive.mockResolvedValue(true);
    const { script } = setup({ tools: REGISTRY });

    await expect(script("await tools.mail_send({});")).resolves.toBeUndefined();
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
  });

  it("says so when the script can pick tools by name", async () => {
    const { script, batch } = setup({ tools: REGISTRY });

    await script(
      [
        "await tools.mail_send({ to, subject });",
        "const extra = await searchTools('archive mail');",
        "for (const t of extra) await tools[t.name]({});",
      ].join("\n"),
    );

    expect(batch()).toMatchObject({ dynamic: true });
  });

  it("blocks the whole script when the approval is denied", async () => {
    mockRequestToolApproval.mockResolvedValue("denied");
    const { script, granted, sessionId } = setup({ tools: REGISTRY });
    const toolCallId = uniqueId("call");

    const result = await script("await tools.mail_send({});", toolCallId);

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("denied");
    expect(granted(sessionId, toolCallId, "mail_send")).toBe(false);
  });

  it("reports a stopped run as stopped, not as a denial", async () => {
    mockRequestToolApproval.mockResolvedValue("aborted");
    const { script } = setup({ tools: REGISTRY });

    const result = await script("await tools.mail_send({});");
    expect(result?.reason).toContain("stopped");
  });

  it("stops covering the calls once the script's result arrives", async () => {
    const { script, onToolResult, granted, sessionId } = setup({ tools: REGISTRY });
    const toolCallId = uniqueId("call");

    await script("await tools.mail_send({});", toolCallId);
    expect(granted(sessionId, toolCallId, "mail_send")).toBe(true);

    await onToolResult({ toolCallId });

    expect(granted(sessionId, toolCallId, "mail_send")).toBe(false);
  });

  it("leaves another run's grant alone when its own script finishes", async () => {
    const { script, onToolResult, granted, sessionId } = setup({ tools: REGISTRY });
    const other = uniqueId("call");
    grantApprovalScope({
      sessionId,
      toolCallId: other,
      tools: ["mail_send"],
      expiresAt: Date.now() + 60_000,
    });

    const own = uniqueId("call");
    await script("await tools.mail_send({});", own);
    await onToolResult({ toolCallId: own });

    expect(granted(sessionId, other, "mail_send")).toBe(true);
  });
});
