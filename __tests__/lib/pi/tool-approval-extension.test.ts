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

import { isApprovalScopeGranted } from "@/lib/pi/approval-scope";
import { createToolApprovalExtension } from "@/lib/pi/tool-approval-extension";
import type { ToolApprovalOptions } from "@/lib/pi/tool-approval-extension";

/** A tool as the extension sees it in the session's registry. */
interface RegistryTool {
  name: string;
  exposure?: "direct" | "codemode" | "deferred" | "model-only" | "hidden";
  readOnly?: boolean;
}

interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: Record<string, unknown>;
}

type Handler = (
  event: ToolCallEvent,
  ctx: { signal?: AbortSignal | undefined },
) => Promise<unknown>;

/**
 * Unique ids per test: an approval scope grant outlives the call that created
 * it, so a repeated id would let one test's grant cover the next test's calls.
 */
let sequence = 0;
function uniqueId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function setup(
  options: {
    tools?: RegistryTool[];
    active?: string[];
    gate?: Partial<ToolApprovalOptions>;
  } = {},
) {
  const handlers: Record<string, Handler> = {};
  const tools = options.tools ?? [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
      return () => {};
    },
    getAllTools: () =>
      tools.map((tool) => ({
        name: tool.name,
        exposure: tool.exposure ?? "direct",
        ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      })),
    getActiveTools: () => options.active ?? tools.map((tool) => tool.name),
  };

  const sessionId = uniqueId("session");
  const emitApprovalRequest = vi.fn();
  createToolApprovalExtension({
    userId: "user-1",
    sessionId,
    toolPolicies: null,
    emitApprovalRequest,
    ...options.gate,
  })(pi as never);

  const onToolCall = handlers["tool_call"];
  if (!onToolCall) throw new Error("the extension registered no tool_call handler");

  return {
    sessionId,
    emitApprovalRequest,
    call: (
      event: Omit<ToolCallEvent, "toolCallId"> & { toolCallId?: string },
      signal?: AbortSignal,
    ) => onToolCall({ toolCallId: uniqueId("call"), ...event }, { signal }),
    onToolResult: handlers["tool_result"] as unknown as (
      event: Record<string, unknown>,
    ) => Promise<unknown>,
  };
}

describe("tool approval gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAutoApproveActive.mockResolvedValue(false);
    mockRequestToolApproval.mockResolvedValue("approved");
  });

  describe("policy", () => {
    it("blocks a tool the user turned off", async () => {
      const { call } = setup({ gate: { toolPolicies: { bash: "off" } } });
      const result = await call({ toolName: "bash", input: { command: "ls" } });
      expect(result).toEqual({ block: true, reason: expect.stringContaining("disabled") });
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });

    it("runs a tool set to allow without asking", async () => {
      const { call } = setup({ gate: { toolPolicies: { mail_send: "allow" } } });
      expect(await call({ toolName: "mail_send", input: {} })).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });

    it("asks for a tool set to ask and runs it once approved", async () => {
      const { call } = setup({ gate: { toolPolicies: { mail_send: "ask" } } });
      expect(await call({ toolName: "mail_send", input: { to: "a@b.c" } })).toBeUndefined();
      expect(mockRequestToolApproval).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "mail_send", args: { to: "a@b.c" } }),
      );
    });

    it("blocks a tool the user denied", async () => {
      mockRequestToolApproval.mockResolvedValue("denied");
      const { call } = setup({ gate: { toolPolicies: { mail_send: "ask" } } });
      expect(await call({ toolName: "mail_send", input: {} })).toEqual({
        block: true,
        reason: expect.stringContaining("denied"),
      });
    });

    it("reports a stopped run as stopped, not as a denial", async () => {
      mockRequestToolApproval.mockResolvedValue("aborted");
      const { call } = setup({ gate: { toolPolicies: { mail_send: "ask" } } });
      expect(await call({ toolName: "mail_send", input: {} })).toEqual({
        block: true,
        reason: expect.stringContaining("stopped"),
      });
    });

    it("follows a tool's catalog default when the user set nothing", async () => {
      // `read` ships allowed, `mail_send` ships as ask: neither is configured.
      const { call } = setup();
      expect(await call({ toolName: "read", input: { filePath: "a.txt" } })).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
      await call({ toolName: "mail_send", input: {} });
      expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    });

    it("lets a read-only tool nobody configured run", async () => {
      const { call } = setup({ tools: [{ name: "plugin_stats", readOnly: true }] });
      expect(await call({ toolName: "plugin_stats", input: {} })).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });

    it("asks for a plugin tool that does not declare itself read-only", async () => {
      const { call } = setup({ tools: [{ name: "plugin_deploy" }] });
      await call({ toolName: "plugin_deploy", input: {} });
      expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    });

    it("lets the user's policy override what a plugin tool declares", async () => {
      const { call } = setup({
        tools: [{ name: "plugin_stats", readOnly: true }],
        gate: { toolPolicies: { plugin_stats: "off" } },
      });
      expect(await call({ toolName: "plugin_stats", input: {} })).toEqual({
        block: true,
        reason: expect.stringContaining("disabled"),
      });
    });
  });

  describe("auto-approve window", () => {
    it("runs what would ask while /stfu is active", async () => {
      mockIsAutoApproveActive.mockResolvedValue(true);
      const { call } = setup({ gate: { toolPolicies: { mail_send: "ask" } } });
      expect(await call({ toolName: "mail_send", input: {} })).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });

    it("keeps a tool the user turned off blocked", async () => {
      mockIsAutoApproveActive.mockResolvedValue(true);
      const { call } = setup({ gate: { toolPolicies: { mail_send: "off" } } });
      expect(await call({ toolName: "mail_send", input: {} })).toEqual({
        block: true,
        reason: expect.stringContaining("disabled"),
      });
    });
  });

  describe("command-aware auto", () => {
    it("runs a safe bash command", async () => {
      const { call } = setup();
      expect(await call({ toolName: "bash", input: { command: "ls -la" } })).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });

    it("asks for a risky bash command", async () => {
      const { call } = setup();
      await call({ toolName: "bash", input: { command: "rm -rf /tmp/x" } });
      expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    });

    it("treats a command-aware tool called without a command as risky", async () => {
      const { call } = setup();
      await call({ toolName: "bash", input: {} });
      expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    });

    it("treats auto on any other tool as allow", async () => {
      const { call } = setup({ gate: { toolPolicies: { write: "auto" } } });
      expect(await call({ toolName: "write", input: { filePath: "a.txt" } })).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });
  });

  describe("codemode scripts", () => {
    const REGISTRY: RegistryTool[] = [
      { name: "codemode", exposure: "model-only" },
      { name: "mail_send" },
      { name: "mail_search" },
      { name: "task_delete" },
    ];

    it("runs a script whose calls would not ask", async () => {
      const { call } = setup({
        tools: REGISTRY,
        gate: { toolPolicies: { mail_search: "allow" } },
      });
      const script = "await tools.mail_search({ query: 'x' })";
      expect(await call({ toolName: "codemode", input: { code: script } })).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });

    it("asks once, covering the calls that would ask on their own", async () => {
      const { call } = setup({ tools: REGISTRY, gate: { toolPolicies: { mail_search: "allow" } } });
      const script = "await tools.mail_search({ query: 'x' }); await tools.mail_send({ to: 'a' })";
      expect(await call({ toolName: "codemode", input: { code: script } })).toBeUndefined();
      expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
      expect(mockRequestToolApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "codemode",
          batch: { tools: ["mail_send"], dynamic: false },
        }),
      );
    });

    it("off blocks scripts outright", async () => {
      const { call } = setup({ tools: REGISTRY, gate: { toolPolicies: { codemode: "off" } } });
      expect(
        await call({ toolName: "codemode", input: { code: "await tools.mail_send({})" } }),
      ).toEqual({ block: true, reason: expect.stringContaining("disabled") });
    });

    it("allow runs the script as one step, whatever it reaches", async () => {
      const { call } = setup({ tools: REGISTRY, gate: { toolPolicies: { codemode: "allow" } } });
      expect(
        await call({ toolName: "codemode", input: { code: "await tools.mail_send({})" } }),
      ).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });

    it("ask always asks, even when nothing the script reaches would", async () => {
      const { call } = setup({
        tools: REGISTRY,
        gate: { toolPolicies: { codemode: "ask", mail_search: "allow" } },
      });
      expect(await call({ toolName: "codemode", input: { code: "1 + 1" } })).toBeUndefined();
      expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
      expect(mockRequestToolApproval).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "codemode" }),
      );
    });

    it("covers the announced calls after approval, and nothing else", async () => {
      const { call, sessionId } = setup({ tools: REGISTRY });
      const toolCallId = uniqueId("script");
      const script = "await tools.mail_send({ to: 'a' })";
      await call({ toolName: "codemode", toolCallId, input: { code: script } });

      expect(
        isApprovalScopeGranted({ sessionId, toolCallId: `${toolCallId}/1`, toolName: "mail_send" }),
      ).toBe(true);
      expect(
        isApprovalScopeGranted({
          sessionId,
          toolCallId: `${toolCallId}/1`,
          toolName: "task_delete",
        }),
      ).toBe(false);

      // A covered call runs without a second card.
      mockRequestToolApproval.mockClear();
      expect(
        await call({
          toolName: "mail_send",
          toolCallId: `${toolCallId}/1`,
          parentToolCallId: toolCallId,
          input: {},
        }),
      ).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();

      // One the script did not announce asks for itself.
      await call({
        toolName: "task_delete",
        toolCallId: `${toolCallId}/2`,
        parentToolCallId: toolCallId,
        input: {},
      });
      expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    });

    it("leaves a read-only plugin tool off the card, as a direct call does", async () => {
      const { call } = setup({
        tools: [...REGISTRY, { name: "plugin_lookup", readOnly: true }],
      });

      // Read-only runs on its own, so it is not a call the card has to cover.
      expect(await call({ toolName: "plugin_lookup", input: {} })).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();

      // Nothing the script reaches would ask on its own, so it costs no click.
      expect(
        await call({ toolName: "codemode", input: { code: "await tools.plugin_lookup({})" } }),
      ).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });

    it("asks nothing for a script that only searches the catalog", async () => {
      const { call } = setup({ tools: REGISTRY });
      // Searching is how the model reaches a deferred tool. The script names none
      // of them, so there is nothing to put on a card; the calls it makes ask
      // for themselves, as a direct call would.
      expect(
        await call({
          toolName: "codemode",
          input: { code: "const found = await searchTools('mail'); return found;" },
        }),
      ).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });

    it("notes the tools a script can still pick by name", async () => {
      const { call } = setup({ tools: REGISTRY });
      await call({
        toolName: "codemode",
        input: { code: "await tools.mail_send({ to: 'a' }); await tools[pick()]({});" },
      });
      expect(mockRequestToolApproval).toHaveBeenCalledWith(
        expect.objectContaining({ batch: { tools: ["mail_send"], dynamic: true } }),
      );
    });

    it("leaves a call the script picked by name to ask for itself", async () => {
      const { call, sessionId } = setup({ tools: REGISTRY });
      const toolCallId = uniqueId("script");
      await call({
        toolName: "codemode",
        toolCallId,
        input: { code: "await tools[pick()]({});" },
      });
      expect(mockRequestToolApproval).not.toHaveBeenCalled();

      await call({
        toolName: "mail_send",
        toolCallId: `${toolCallId}/1`,
        parentToolCallId: toolCallId,
        input: { to: "a" },
      });
      expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
      expect(isApprovalScopeGranted({ sessionId, toolCallId, toolName: "mail_send" })).toBe(false);
    });

    it("releases the scope when the script's result arrives", async () => {
      const { call, onToolResult, sessionId } = setup({ tools: REGISTRY });
      const toolCallId = uniqueId("script");
      await call({
        toolName: "codemode",
        toolCallId,
        input: { code: "await tools.mail_send({})" },
      });
      expect(isApprovalScopeGranted({ sessionId, toolCallId, toolName: "mail_send" })).toBe(true);

      await onToolResult({ toolName: "codemode", toolCallId, input: {} });
      expect(isApprovalScopeGranted({ sessionId, toolCallId, toolName: "mail_send" })).toBe(false);
    });

    it("leaves a nested codemode call alone", async () => {
      const { call } = setup({ tools: REGISTRY });
      expect(
        await call({
          toolName: "codemode",
          parentToolCallId: "call-parent",
          input: { code: "await tools.mail_send({})" },
        }),
      ).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });
  });

  describe("MCP tools", () => {
    const SERVERS = { docs: "ask" as const, wiki: "allow" as const, mail: "off" as const };

    it("asks for a tool on an ask server", async () => {
      const { call } = setup({ gate: { mcpServerPolicies: SERVERS } });
      await call({ toolName: "mcp__docs__search", input: {} });
      expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    });

    it("runs a tool on an allow server", async () => {
      const { call } = setup({ gate: { mcpServerPolicies: SERVERS } });
      expect(await call({ toolName: "mcp__wiki__search", input: {} })).toBeUndefined();
    });

    it("blocks a tool on an off server, calling it disabled", async () => {
      const { call } = setup({ gate: { mcpServerPolicies: SERVERS } });
      expect(await call({ toolName: "mcp__mail__send", input: {} })).toEqual({
        block: true,
        reason: expect.stringContaining("disabled"),
      });
    });

    it("lets a per-tool policy override the server's", async () => {
      const { call } = setup({
        gate: { mcpServerPolicies: SERVERS, toolPolicies: { mcp__docs__search: "allow" } },
      });
      expect(await call({ toolName: "mcp__docs__search", input: {} })).toBeUndefined();
      expect(mockRequestToolApproval).not.toHaveBeenCalled();
    });

    it("fails closed for a server it does not know", async () => {
      const { call } = setup({ gate: { mcpServerPolicies: SERVERS } });
      await call({ toolName: "mcp__unknown__run", input: {} });
      expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    });
  });

  it("passes the run's abort signal to the approval wait", async () => {
    const controller = new AbortController();
    const { call } = setup({ gate: { toolPolicies: { mail_send: "ask" } } });
    await call({ toolName: "mail_send", input: {} }, controller.signal);
    expect(mockRequestToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
