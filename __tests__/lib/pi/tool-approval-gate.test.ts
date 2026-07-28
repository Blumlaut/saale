import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  waitForApproval,
  resolveApproval,
  getPendingApprovals,
  APPROVAL_TIMEOUT_MS,
  wrapWithApprovalGate,
  type ApprovalRequest,
} from "@/lib/pi/tool-approval-gate";

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

describe("tool-approval-gate", () => {
  const makeRequest = (): ApprovalRequest => ({
    toolCallId: "tc-123",
    toolName: "bash",
    sessionId: "session-abc",
    userId: "user-1",
    args: { cmd: "ls" },
    createdAt: Date.now(),
    expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
  });

  // ─── waitForApproval / resolveApproval ───────────────────────────────

  describe("waitForApproval / resolveApproval", () => {
    it("resolves true when approved", async () => {
      const request = makeRequest();
      const promise = waitForApproval(request);

      await new Promise((r) => setTimeout(r, 10));
      await resolveApproval(request.sessionId, request.toolCallId, true);

      const result = await promise;
      expect(result).toBe(true);
    });

    it("resolves false when denied", async () => {
      const request = makeRequest();
      const promise = waitForApproval(request);

      await new Promise((r) => setTimeout(r, 10));
      await resolveApproval(request.sessionId, request.toolCallId, false);

      const result = await promise;
      expect(result).toBe(false);
    });

    it("returns false for non-existent approval", async () => {
      const resolved = await resolveApproval("fake-session", "fake-tc", true);
      expect(resolved).toBe(false);
    });

    it("resolves false on timeout", async () => {
      const request: ApprovalRequest = {
        toolCallId: "tc-timeout",
        toolName: "bash",
        sessionId: "session-timeout",
        userId: "user-1",
        args: {},
        createdAt: Date.now(),
        expiresAt: Date.now() + 50,
      };
      const promise = waitForApproval(request);
      const result = await promise;
      expect(result).toBe(false);
    });

    it("stores and retrieves pending approvals in Redis", async () => {
      const request = makeRequest();
      const promise = waitForApproval(request);

      await new Promise((r) => setTimeout(r, 50));

      const pending = await getPendingApprovals(request.sessionId);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.toolName).toBe("bash");

      await resolveApproval(request.sessionId, request.toolCallId, true);
      await promise;
    });

    it("getPendingApprovals filters expired requests", async () => {
      const expiredRequest: ApprovalRequest = {
        toolCallId: "tc-expired",
        toolName: "bash",
        sessionId: "session-expired",
        userId: "user-1",
        args: {},
        createdAt: Date.now() - 10000,
        expiresAt: Date.now() - 5000,
      };
      const promise = waitForApproval(expiredRequest);
      await promise;

      const pending = await getPendingApprovals("session-expired");
      expect(pending).toHaveLength(0);
    });
  });

  // ─── Double resolution safety ────────────────────────────────────────

  describe("double resolution", () => {
    it("ignores second resolve", async () => {
      const request = makeRequest();
      const promise = waitForApproval(request);

      await new Promise((r) => setTimeout(r, 10));
      await resolveApproval(request.sessionId, request.toolCallId, true);
      const result = await promise;
      expect(result).toBe(true);

      const second = await resolveApproval(request.sessionId, request.toolCallId, false);
      expect(second).toBe(false);
    });
  });

  // ─── wrapWithApprovalGate ────────────────────────────────────────────

  describe("wrapWithApprovalGate", () => {
    it("blocks tools with 'off' policy", async () => {
      const tool = wrapWithApprovalGate(
        makeMockTool("bash", async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        })),
        "user-1",
        "session-test",
        async () => "off",
        () => {},
      );

      const result = (await tool.execute(
        "tc-1",
        { cmd: "ls" },
        undefined,
        undefined,
        {} as never,
      )) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("disabled");
    });

    it("allows tools with 'allow' policy", async () => {
      let executed = false;
      const tool = wrapWithApprovalGate(
        makeMockTool("bash", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "ok" }],
            details: {},
          };
        }),
        "user-1",
        "session-test",
        async () => "allow",
        () => {},
      );

      await tool.execute("tc-1", { cmd: "ls" }, undefined, undefined, {} as never);
      expect(executed).toBe(true);
    });

    it("emits approval request and waits for 'ask' policy", async () => {
      let emittedRequest: ApprovalRequest | null = null;
      const tool = wrapWithApprovalGate(
        makeMockTool("bash", async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        })),
        "user-1",
        "session-test",
        async () => "ask",
        (request) => {
          emittedRequest = request;
        },
      );

      const promise = tool.execute("tc-1", { cmd: "ls" }, undefined, undefined, {} as never);

      await new Promise((r) => setTimeout(r, 50));
      expect(emittedRequest).not.toBeNull();
      expect(emittedRequest!.toolName).toBe("bash");

      await resolveApproval("session-test", "tc-1", true);
      const result = (await promise) as ToolResult;
      expect(result.content[0].text).toBe("ok");
    });

    it("denies tool when approval is rejected", async () => {
      const tool = wrapWithApprovalGate(
        makeMockTool("bash", async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        })),
        "user-1",
        "session-test",
        async () => "ask",
        () => {},
      );

      const promise = tool.execute("tc-1", { cmd: "ls" }, undefined, undefined, {} as never);

      await new Promise((r) => setTimeout(r, 50));
      await resolveApproval("session-test", "tc-1", false);
      const result = (await promise) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("denied");
    });

    it("auto policy: infra_exec with safe command executes without approval", async () => {
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
        "session-test",
        async () => "auto",
        (request) => {
          emittedRequests.push(request);
        },
      );

      const result = (await tool.execute(
        "tc-1",
        { id: "machine-1", command: "ls -la" },
        undefined,
        undefined,
        {} as never,
      )) as ToolResult;

      expect(executed).toBe(true);
      expect(emittedRequests).toHaveLength(0);
      expect(result.content[0].text).toBe("Command executed");
    });

    it("auto policy: infra_exec with risky command requires approval", async () => {
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
        "session-test",
        async () => "auto",
        (request) => {
          emittedRequests.push(request);
        },
      );

      const promise = tool.execute(
        "tc-1",
        { id: "machine-1", command: "rm -rf /tmp/data" },
        undefined,
        undefined,
        {} as never,
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should have emitted an approval request
      expect(emittedRequests).toHaveLength(1);
      const request = emittedRequests[0]!;
      expect(request.toolName).toBe("infra_exec");
      expect(request.args.command).toBe("rm -rf /tmp/data");

      // Tool should not have executed yet
      expect(executed).toBe(false);

      // Approve
      await resolveApproval("session-test", "tc-1", true);
      const result = (await promise) as ToolResult;

      expect(executed).toBe(true);
      expect(result.content[0].text).toBe("Command executed");
    });

    it("auto policy: non-infra tools behave like 'allow'", async () => {
      let executed = false;
      const emittedRequests: ApprovalRequest[] = [];

      const tool = wrapWithApprovalGate(
        makeMockTool("mail_send", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "Email sent" }],
            details: {},
          };
        }),
        "user-1",
        "session-test",
        async () => "auto",
        (request) => {
          emittedRequests.push(request);
        },
      );

      const result = (await tool.execute(
        "tc-1",
        { to: "test@example.com", body: "Hello" },
        undefined,
        undefined,
        {} as never,
      )) as ToolResult;

      expect(executed).toBe(true);
      expect(emittedRequests).toHaveLength(0);
      expect(result.content[0].text).toBe("Email sent");
    });

    it("auto policy: bash with safe command executes without approval", async () => {
      let executed = false;
      const emittedRequests: ApprovalRequest[] = [];

      const tool = wrapWithApprovalGate(
        makeMockTool("bash", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "ok" }],
            details: {},
          };
        }),
        "user-1",
        "session-test",
        async () => "auto",
        (request) => {
          emittedRequests.push(request);
        },
      );

      const result = (await tool.execute(
        "tc-1",
        { command: "ls -la /home" },
        undefined,
        undefined,
        {} as never,
      )) as ToolResult;

      expect(executed).toBe(true);
      expect(emittedRequests).toHaveLength(0);
      expect(result.content[0].text).toBe("ok");
    });

    it("auto policy: bash with risky command requires approval", async () => {
      let executed = false;
      const emittedRequests: ApprovalRequest[] = [];

      const tool = wrapWithApprovalGate(
        makeMockTool("bash", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "ok" }],
            details: {},
          };
        }),
        "user-1",
        "session-test",
        async () => "auto",
        (request) => {
          emittedRequests.push(request);
        },
      );

      const promise = tool.execute(
        "tc-1",
        { command: "rm -rf /tmp/data" },
        undefined,
        undefined,
        {} as never,
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(emittedRequests).toHaveLength(1);
      expect(executed).toBe(false);

      await resolveApproval("session-test", "tc-1", true);
      const result = (await promise) as ToolResult;

      expect(executed).toBe(true);
      expect(result.content[0].text).toBe("ok");
    });
  });
});
