import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { publishSessionEvent } from "@/lib/pi/session-events";

// The approval gate persists requests in Redis and coordinates cross-process
// resolution over Redis pub/sub. Replace the real (ioredis-backed) module
// with an in-memory implementation so tests run without a Redis server.
vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));

// The approval gate enriches requests with a resolved summary, which may
// look up the referenced record. Tests run without a database — every
// lookup resolves to "not found".
vi.mock("@/lib/db", () => ({
  prisma: {
    infraMachine: { findFirst: vi.fn().mockResolvedValue(null) },
    calendarEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    task: { findFirst: vi.fn().mockResolvedValue(null) },
    chatSession: { findFirst: vi.fn().mockResolvedValue(null) },
    emailMessage: { findMany: vi.fn().mockResolvedValue([]) },
    queueTask: { findFirst: vi.fn().mockResolvedValue(null) },
    agentDefinition: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { resetMockRedis, getRedis } from "../../helpers/in-memory-redis";
import {
  waitForApproval,
  resolveApproval,
  getPendingApprovals,
  APPROVAL_TIMEOUT_MS,
  wrapWithApprovalGate,
  createToolApprovalGate,
  type ApprovalRequest,
} from "@/lib/pi/tool-approval-gate";
import { grantApprovalScope } from "@/lib/pi/approval-scope";

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

// Unique IDs per test: resolution events travel on the shared session bus,
// so reusing a toolCallId/sessionId across tests lets a leftover event from
// one test settle another test's wait.
let idCounter = 0;

function makeUniqueIds(prefix: string): { toolCallId: string; sessionId: string } {
  idCounter += 1;
  return { toolCallId: `${prefix}-${idCounter}`, sessionId: `${prefix}-session-${idCounter}` };
}

describe("tool-approval-gate", () => {
  beforeEach(() => {
    resetMockRedis();
  });
  const makeRequest = (): ApprovalRequest => {
    const { toolCallId, sessionId } = makeUniqueIds("tc");
    return {
      toolCallId,
      toolName: "bash",
      sessionId,
      userId: "user-1",
      args: { cmd: "ls" },
      createdAt: Date.now(),
      expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
    };
  };

  // ─── waitForApproval / resolveApproval ───────────────────────────────

  describe("waitForApproval / resolveApproval", () => {
    it("resolves true when approved", async () => {
      const request = makeRequest();
      const promise = waitForApproval(request);

      await new Promise((r) => setTimeout(r, 10));
      await resolveApproval(request.sessionId, request.toolCallId, true);

      const result = await promise;
      expect(result).toBe("approved");
    });

    it("resolves denied when denied", async () => {
      const request = makeRequest();
      const promise = waitForApproval(request);

      await new Promise((r) => setTimeout(r, 10));
      await resolveApproval(request.sessionId, request.toolCallId, false);

      const result = await promise;
      expect(result).toBe("denied");
    });

    it("returns false for non-existent approval", async () => {
      const resolved = await resolveApproval("fake-session", "fake-tc", true);
      expect(resolved).toBe(false);
    });

    it("resolves denied on timeout", async () => {
      const request: ApprovalRequest = {
        toolCallId: "tc-timeout-gate",
        toolName: "bash",
        sessionId: "session-timeout-gate",
        userId: "user-1",
        args: {},
        createdAt: Date.now(),
        expiresAt: Date.now() + 50,
      };
      const promise = waitForApproval(request);
      const result = await promise;
      expect(result).toBe("denied");
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

    it("getPendingApprovals excludes resolved requests", async () => {
      const request = makeRequest();
      const promise = waitForApproval(request);

      await new Promise((r) => setTimeout(r, 10));
      await resolveApproval(request.sessionId, request.toolCallId, true);
      await promise;

      const pending = await getPendingApprovals(request.sessionId);
      expect(pending).toHaveLength(0);
    });

    it("resolves from a resolution event published by another process", async () => {
      // Simulates the web API route (or Telegram callback) resolving an
      // approval whose agent runs in a different process: no in-process
      // promise exists here — only the session bus event can wake the wait.
      const request = { ...makeRequest(), toolCallId: "tc-bus", sessionId: "session-bus" };
      const promise = waitForApproval(request);

      // Let the bus subscription settle before publishing.
      await new Promise((r) => setTimeout(r, 100));

      await publishSessionEvent(request.sessionId, "tool_approval_resolved", {
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        approved: true,
        expiresAt: new Date(request.expiresAt).toISOString(),
      });

      const result = await promise;
      expect(result).toBe("approved");
    });

    it("resolves false and cleans up when the agent is aborted", async () => {
      const request = { ...makeRequest(), toolCallId: "tc-abort", sessionId: "session-abort" };
      const controller = new AbortController();
      const promise = waitForApproval(request, controller.signal);

      await new Promise((r) => setTimeout(r, 20));
      controller.abort();

      const result = await promise;
      expect(result).toBe("aborted");

      const pending = await getPendingApprovals(request.sessionId);
      expect(pending).toHaveLength(0);
    });

    it("records a cancellation, not a denial, when the run is aborted", async () => {
      const request = { ...makeRequest(), toolCallId: "tc-abort-record" };
      const controller = new AbortController();
      const promise = waitForApproval(request, controller.signal);

      await new Promise((r) => setTimeout(r, 20));
      controller.abort();
      expect(await promise).toBe("aborted");

      // Nothing was decided by the user, so no decision may be recorded.
      expect(await resolveApproval(request.sessionId, request.toolCallId, false)).toBe(false);
      expect(await getPendingApprovals(request.sessionId)).toHaveLength(0);

      const raw = await getRedis().get(`saale:approval:${request.sessionId}:${request.toolCallId}`);
      expect(JSON.parse(raw as string)).toMatchObject({ cancelled: true });
      expect(JSON.parse(raw as string).approved).toBeUndefined();
    });

    it("prefers a decision that landed just before the abort", async () => {
      const request = { ...makeRequest(), toolCallId: "tc-abort-raced" };
      const controller = new AbortController();
      const promise = waitForApproval(request, controller.signal);

      await new Promise((r) => setTimeout(r, 20));
      // The user approved in another process, the run is stopped immediately
      // after: the recorded decision is the truth, not the abort.
      await resolveApproval(request.sessionId, request.toolCallId, true);
      controller.abort();

      expect(await promise).toBe("approved");
    });

    it("timeout records a denial so no stale approval survives", async () => {
      const request: ApprovalRequest = {
        ...makeRequest(),
        toolCallId: "tc-tout-cleanup",
        sessionId: "session-tout-cleanup",
        expiresAt: Date.now() + 60,
      };
      const promise = waitForApproval(request);

      expect(await promise).toBe("denied");

      // The timed-out request is not pending anymore…
      const pending = await getPendingApprovals(request.sessionId);
      expect(pending).toHaveLength(0);

      // …and a late approval attempt is idempotently rejected (already
      // decided by the timeout), so the client can dismiss the stale card.
      const late = await resolveApproval(request.sessionId, request.toolCallId, true);
      expect(late).toBe(false);
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
      expect(result).toBe("approved");

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

      // Rejection is a throw: Pi's agent loop overrides `isError` on returned
      // tool results, so returning `isError: true` would reach the model and
      // the UI as a successful call.
      await expect(
        tool.execute("tc-1", { cmd: "ls" }, undefined, undefined, {} as never),
      ).rejects.toThrow(/disabled/);
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
      const { toolCallId, sessionId } = makeUniqueIds("ask");
      const tool = wrapWithApprovalGate(
        makeMockTool("bash", async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        })),
        "user-1",
        sessionId,
        async () => "ask",
        (request) => {
          emittedRequest = request;
        },
      );

      const promise = tool.execute(toolCallId, { cmd: "ls" }, undefined, undefined, {} as never);

      await new Promise((r) => setTimeout(r, 50));
      expect(emittedRequest).not.toBeNull();
      expect(emittedRequest!.toolName).toBe("bash");

      await resolveApproval(sessionId, toolCallId, true);
      const result = (await promise) as ToolResult;
      expect(result.content[0].text).toBe("ok");
    });

    it("surfaces an aborted run as an abort, not a user denial", async () => {
      const { toolCallId, sessionId } = makeUniqueIds("abort");
      let executed = false;
      const tool = wrapWithApprovalGate(
        makeMockTool("bash", async () => {
          executed = true;
          return { content: [{ type: "text", text: "ok" }], details: {} };
        }),
        "user-1",
        sessionId,
        async () => "ask",
        () => {},
      );

      const controller = new AbortController();
      const promise = tool.execute(
        toolCallId,
        { cmd: "ls" },
        controller.signal,
        undefined,
        {} as never,
      );
      const rejection = expect(promise).rejects.toThrow("Operation aborted");

      await new Promise((r) => setTimeout(r, 50));
      controller.abort();
      await rejection;
      // The user never approved: the tool must not run.
      expect(executed).toBe(false);
    });

    it("runs a tool an approved script already covered, without asking", async () => {
      const { sessionId } = makeUniqueIds("covered");
      const emitted: ApprovalRequest[] = [];
      let executed = false;

      // The user approved the script at `script-call`; this is one of the calls
      // it announced, which Pi ids `<parent>/<n>`.
      grantApprovalScope({
        sessionId,
        toolCallId: "script-call",
        tools: ["mail_send"],
        expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
      });

      const tool = wrapWithApprovalGate(
        makeMockTool("mail_send", async () => {
          executed = true;
          return { content: [{ type: "text", text: "sent" }], details: {} };
        }),
        "user-1",
        sessionId,
        async () => "ask",
        (request) => {
          emitted.push(request);
        },
      );

      const result = (await tool.execute(
        "script-call/1",
        { to: "a@b.c" },
        undefined,
        undefined,
        {} as never,
      )) as ToolResult;

      expect(emitted).toHaveLength(0);
      expect(executed).toBe(true);
      expect(result.content[0].text).toBe("sent");
    });

    it("still asks for a nested call the script did not announce", async () => {
      const { sessionId } = makeUniqueIds("uncovered");
      const emitted: ApprovalRequest[] = [];

      grantApprovalScope({
        sessionId,
        toolCallId: "script-call",
        tools: ["mail_send"],
        expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
      });

      const tool = wrapWithApprovalGate(
        makeMockTool("mail_delete", async () => ({
          content: [{ type: "text", text: "deleted" }],
          details: {},
        })),
        "user-1",
        sessionId,
        async () => "ask",
        (request) => {
          emitted.push(request);
        },
      );

      const promise = tool.execute(
        "script-call/2",
        { ids: ["m1"] },
        undefined,
        undefined,
        {} as never,
      );
      const rejection = expect(promise).rejects.toThrow(/denied/);

      await new Promise((r) => setTimeout(r, 50));
      expect(emitted).toHaveLength(1);

      await resolveApproval(sessionId, "script-call/2", false);
      await rejection;
    });

    it("denies tool when approval is rejected", async () => {
      const { toolCallId, sessionId } = makeUniqueIds("deny");
      const tool = wrapWithApprovalGate(
        makeMockTool("bash", async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        })),
        "user-1",
        sessionId,
        async () => "ask",
        () => {},
      );

      const promise = tool.execute(toolCallId, { cmd: "ls" }, undefined, undefined, {} as never);
      const rejection = expect(promise).rejects.toThrow(/denied/);

      await new Promise((r) => setTimeout(r, 50));
      await resolveApproval(sessionId, toolCallId, false);
      await rejection;
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
      const { toolCallId, sessionId } = makeUniqueIds("infra");

      const tool = wrapWithApprovalGate(
        makeMockTool("infra_exec", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "Command executed" }],
            details: {},
          };
        }),
        "user-1",
        sessionId,
        async () => "auto",
        (request) => {
          emittedRequests.push(request);
        },
      );

      const promise = tool.execute(
        toolCallId,
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
      await resolveApproval(sessionId, toolCallId, true);
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
      const { toolCallId, sessionId } = makeUniqueIds("bashrisk");

      const tool = wrapWithApprovalGate(
        makeMockTool("bash", async () => {
          executed = true;
          return {
            content: [{ type: "text", text: "ok" }],
            details: {},
          };
        }),
        "user-1",
        sessionId,
        async () => "auto",
        (request) => {
          emittedRequests.push(request);
        },
      );

      const promise = tool.execute(
        toolCallId,
        { command: "rm -rf /tmp/data" },
        undefined,
        undefined,
        {} as never,
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(emittedRequests).toHaveLength(1);
      expect(executed).toBe(false);

      await resolveApproval(sessionId, toolCallId, true);
      const result = (await promise) as ToolResult;

      expect(executed).toBe(true);
      expect(result.content[0].text).toBe("ok");
    });
  });

  // ─── createToolApprovalGate ───────────────────────────────────────────
  // The gate every chat/tool-hosting entry point uses: it resolves each
  // tool's policy from the user's stored settings and falls back to the
  // tool's built-in default. Entry points that skip it (or build their own
  // resolver) let tools run unapproved.
  describe("createToolApprovalGate", () => {
    const okTool = () =>
      makeMockTool("bash", async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }));

    it("applies the user's stored policy for a tool", async () => {
      const gate = createToolApprovalGate({
        userId: "user-1",
        sessionId: "session-gate",
        toolPolicies: { bash: "off" },
        emitApprovalRequest: () => {},
      });

      await expect(
        gate(okTool()).execute("tc-gate-1", { cmd: "ls" }, undefined, undefined, {} as never),
      ).rejects.toThrow(/disabled/);
    });

    it("falls back to the tool's built-in default policy", async () => {
      // mail_send's built-in default is "ask": the request must be emitted and
      // the tool must not run until it is approved.
      const emitted: ApprovalRequest[] = [];
      let executed = false;
      const gate = createToolApprovalGate({
        userId: "user-1",
        sessionId: "session-gate-default",
        toolPolicies: null,
        emitApprovalRequest: (request) => emitted.push(request),
      });

      const tool = gate(
        makeMockTool("mail_send", async () => {
          executed = true;
          return { content: [{ type: "text", text: "sent" }], details: {} };
        }),
      );

      const promise = tool.execute("tc-gate-2", { to: "a@b.c" }, undefined, undefined, {} as never);
      await new Promise((r) => setTimeout(r, 20));

      expect(emitted).toHaveLength(1);
      expect(executed).toBe(false);

      await resolveApproval("session-gate-default", "tc-gate-2", true);
      const result = (await promise) as ToolResult;
      expect(result.content[0].text).toBe("sent");
    });

    it("ignores an unknown policy value and uses the default", async () => {
      const emitted: ApprovalRequest[] = [];
      const gate = createToolApprovalGate({
        userId: "user-1",
        sessionId: "session-gate-unknown",
        toolPolicies: { mail_send: "banana" },
        emitApprovalRequest: (request) => emitted.push(request),
      });

      const promise = gate(
        makeMockTool("mail_send", async () => ({
          content: [{ type: "text", text: "sent" }],
          details: {},
        })),
      ).execute("tc-gate-3", {}, undefined, undefined, {} as never);

      await new Promise((r) => setTimeout(r, 20));
      expect(emitted).toHaveLength(1);

      await resolveApproval("session-gate-unknown", "tc-gate-3", false);
      await expect(promise).rejects.toThrow(/denied/);
    });
  });
});
