import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  wrapWithApprovalGate,
  resolveApproval,
  type ApprovalRequest,
} from "@/lib/pi/tool-approval-gate";
import { getDefaultPolicy } from "@/lib/pi/tool-infos";

// The approval gate persists requests in Redis and coordinates cross-process
// resolution over Redis pub/sub. Replace the real (ioredis-backed) module
// with an in-memory implementation so tests run without a Redis server.
vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));
import { resetMockRedis } from "../../helpers/in-memory-redis";

/**
 * These tests verify that the Telegram agent processor MUST wrap tools
 * with the approval gate. Without wrapping, tools with "ask" policy
 * execute without user consent — a critical security bug.
 *
 * The tests simulate the tool wrapping logic that the Telegram processor
 * should apply (via resolveTools' wrapWithApproval option).
 */

// Helper to create a minimal tool definition for testing
function makeMockTool(
  name: string,
  executeFn: () => Promise<{
    content: { type: "text"; text: string }[];
    details: Record<string, never>;
  }>,
): ToolDefinition {
  return {
    name,
    label: name,
    description: "Mock tool",
    parameters: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    execute: async () => executeFn(),
  } as unknown as ToolDefinition;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolResult = any;

describe("Telegram tool approval gate — critical security", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockRedis();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("default policy lookup", () => {
    it("infra_exec defaults to 'auto'", () => {
      expect(getDefaultPolicy("infra_exec")).toBe("auto");
    });

    it("infra_write_file defaults to 'ask'", () => {
      expect(getDefaultPolicy("infra_write_file")).toBe("ask");
    });

    it("infra_remove_machine defaults to 'ask'", () => {
      expect(getDefaultPolicy("infra_remove_machine")).toBe("ask");
    });

    it("infra_add_machine defaults to 'ask'", () => {
      expect(getDefaultPolicy("infra_add_machine")).toBe("ask");
    });

    it("mail_send defaults to 'ask'", () => {
      expect(getDefaultPolicy("mail_send")).toBe("ask");
    });

    it("bash defaults to 'auto'", () => {
      expect(getDefaultPolicy("bash")).toBe("auto");
    });

    it("job_run defaults to 'ask'", () => {
      expect(getDefaultPolicy("job_run")).toBe("ask");
    });

    it("agent_job_create defaults to 'ask'", () => {
      expect(getDefaultPolicy("agent_job_create")).toBe("ask");
    });

    it("read defaults to 'allow'", () => {
      expect(getDefaultPolicy("read")).toBe("allow");
    });

    it("mail_read defaults to 'allow'", () => {
      expect(getDefaultPolicy("mail_read")).toBe("allow");
    });

    it("infra_list_machines defaults to 'allow'", () => {
      expect(getDefaultPolicy("infra_list_machines")).toBe("allow");
    });
  });

  describe("approval gate must block 'ask' tools without consent", () => {
    it("infra_exec with 'ask' policy emits approval request before executing", async () => {
      let executed = false;
      const emittedRequests: ApprovalRequest[] = [];

      const tool = wrapWithApprovalGate(
        makeMockTool("infra_exec", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "Command executed" }],
            details: {},
          };
        }),
        "user-1",
        "session-ask-emit",
        async () => "ask",
        (request) => {
          emittedRequests.push(request);
        },
      );

      const promise = tool.execute(
        "tc-ask-emit",
        { id: "machine-1", command: "uname -a" },
        undefined,
        undefined,
        {} as never,
      );

      // Advance timers so the approval gate has time to set up
      await vi.advanceTimersByTimeAsync(50);

      // Approval request should be emitted BEFORE the tool executes
      expect(emittedRequests).toHaveLength(1);
      expect(emittedRequests[0]!.toolName).toBe("infra_exec");
      expect(executed).toBe(false); // Tool should NOT have executed yet

      // Now approve
      await resolveApproval("session-ask-emit", "tc-ask-emit", true);
      const result = (await promise) as ToolResult;

      expect(executed).toBe(true);
      expect(result.content[0].text).toBe("Command executed");
    });

    it("infra_exec without approval gate executes immediately (the bug)", async () => {
      let executed = false;
      const emittedRequests: ApprovalRequest[] = [];

      // Simulate the BUGGY behavior: tool is NOT wrapped
      const unwrappedTool = makeMockTool("infra_exec", async () => {
        executed = true;
        return {
          content: [{ type: "text", text: "Command executed" }],
          details: {},
        };
      });

      // This is what happens WITHOUT the approval gate — the tool runs immediately
      const result = (await unwrappedTool.execute(
        "tc-nogate",
        { id: "machine-1", command: "uname -a" },
        undefined,
        undefined,
        {} as never,
      )) as ToolResult;

      // Tool executed without any approval! This is the bug.
      expect(executed).toBe(true);
      expect(emittedRequests).toHaveLength(0); // No approval was ever requested
      expect(result.content[0].text).toBe("Command executed");
    });

    it("'ask' tool is denied when user rejects", async () => {
      let executed = false;
      const tool = wrapWithApprovalGate(
        makeMockTool("infra_exec", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "Command executed" }],
            details: {},
          };
        }),
        "user-1",
        "session-deny",
        async () => "ask",
        () => {},
      );

      const promise = tool.execute(
        "tc-deny",
        { id: "machine-1", command: "rm -rf /" },
        undefined,
        undefined,
        {} as never,
      );

      const rejection = expect(promise).rejects.toThrow(/denied/);
      await vi.advanceTimersByTimeAsync(50);
      await resolveApproval("session-deny", "tc-deny", false);
      await rejection;

      expect(executed).toBe(false);
    });

    it("'ask' tool is denied on timeout", async () => {
      let executed = false;
      const tool = wrapWithApprovalGate(
        makeMockTool("infra_exec", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "Command executed" }],
            details: {},
          };
        }),
        "user-1",
        "session-timeout",
        async () => "ask",
        () => {},
      );

      const promise = tool.execute(
        "tc-timeout",
        { id: "machine-1", command: "ls" },
        undefined,
        undefined,
        {} as never,
      );

      const rejection = expect(promise).rejects.toThrow(/denied/);
      // Advance past the default 5-minute timeout
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      await rejection;

      expect(executed).toBe(false);
    });

    it("'off' policy blocks tool immediately", async () => {
      let executed = false;
      const tool = wrapWithApprovalGate(
        makeMockTool("infra_exec", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "Command executed" }],
            details: {},
          };
        }),
        "user-1",
        "session-off",
        async () => "off",
        () => {},
      );

      await expect(
        tool.execute(
          "tc-off",
          { id: "machine-1", command: "ls" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/disabled/);

      expect(executed).toBe(false);
    });

    it("'allow' policy executes immediately without approval", async () => {
      let executed = false;
      const tool = wrapWithApprovalGate(
        makeMockTool("infra_list_machines", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "2 machines found" }],
            details: {},
          };
        }),
        "user-1",
        "session-allow",
        async () => "allow",
        () => {
          throw new Error("Should not emit approval for 'allow' policy");
        },
      );

      const result = (await tool.execute(
        "tc-allow",
        {},
        undefined,
        undefined,
        {} as never,
      )) as ToolResult;

      expect(executed).toBe(true);
      expect(result.content[0].text).toBe("2 machines found");
    });
  });

  describe("user policy overrides default", () => {
    it("user can override 'ask' default to 'allow'", async () => {
      let executed = false;
      const userPolicies: Record<string, string> = { infra_exec: "allow" };
      const getPolicy = async (name: string): Promise<"off" | "ask" | "allow"> =>
        (userPolicies[name] ?? getDefaultPolicy(name)) as "off" | "ask" | "allow";

      const tool = wrapWithApprovalGate(
        makeMockTool("infra_exec", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "ok" }],
            details: {},
          };
        }),
        "user-1",
        "session-allow2",
        getPolicy,
        () => {
          throw new Error("Should not emit approval — user set to 'allow'");
        },
      );

      await tool.execute("tc-allow2", {}, undefined, undefined, {} as never);
      expect(executed).toBe(true);
    });

    it("user can override 'allow' default to 'ask'", async () => {
      let executed = false;
      const emittedRequests: ApprovalRequest[] = [];
      const userPolicies: Record<string, string> = { infra_list_machines: "ask" };
      const getPolicy = async (name: string): Promise<"off" | "ask" | "allow"> =>
        (userPolicies[name] ?? getDefaultPolicy(name)) as "off" | "ask" | "allow";

      const tool = wrapWithApprovalGate(
        makeMockTool("infra_list_machines", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "ok" }],
            details: {},
          };
        }),
        "user-1",
        "session-ask2",
        getPolicy,
        (request) => {
          emittedRequests.push(request);
        },
      );

      const promise = tool.execute("tc-ask2", {}, undefined, undefined, {} as never);

      await vi.advanceTimersByTimeAsync(50);
      expect(emittedRequests).toHaveLength(1);
      expect(executed).toBe(false);

      await resolveApproval("session-ask2", "tc-ask2", true);
      await promise;
      expect(executed).toBe(true);
    });
  });

  describe("all ask-by-default tools require approval", () => {
    const askByDefault = [
      "write",
      "edit",
      "mail_send",
      "mail_delete",
      "job_run",
      "job_delete",
      "calendar_delete",
      "task_delete",
      "agent_job_create",
      "agent_job_run",
      "agent_job_delete",
      "infra_add_machine",
      "infra_write_file",
      "infra_remove_machine",
    ];

    it.each(askByDefault)("'%s' defaults to 'ask' policy", (toolName) => {
      expect(getDefaultPolicy(toolName)).toBe("ask");
    });

    it.each(["infra_exec", "bash"])("'%s' defaults to 'auto' policy", (toolName) => {
      expect(getDefaultPolicy(toolName)).toBe("auto");
    });
  });
});
