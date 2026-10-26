import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The approval gate persists requests in Redis and coordinates cross-process
// resolution over Redis pub/sub. Replace the real (ioredis-backed) module
// with an in-memory implementation so tests run without a Redis server.
vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));

// The approval gate enriches requests with a resolved summary, which may
// look up the referenced record. Tests run without a database  every
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

import { resetMockRedis } from "../../helpers/in-memory-redis";
import { createToolApprovalExtension } from "@/lib/pi/tool-approval-extension";
import {
  APPROVAL_TIMEOUT_MS,
  resolveApproval,
  type ApprovalRequest,
} from "@/lib/pi/tool-approval-gate";
import { getDefaultPolicy } from "@/lib/pi/tool-infos";

interface CallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/**
 * A Telegram session's gate. The bot answers an approval through
 * `resolveApproval` (its inline keyboard), exactly like the web client does,
 * so the gate is the same one and only the channel differs.
 */
function makeGate(toolPolicies: Record<string, string>, sessionId: string) {
  let handler:
    ((event: CallEvent, ctx: { signal?: AbortSignal | undefined }) => Promise<unknown>) | null =
    null;
  const requests: ApprovalRequest[] = [];

  createToolApprovalExtension({
    userId: "user-1",
    sessionId,
    toolPolicies,
    emitApprovalRequest: (request) => {
      requests.push(request);
    },
  })({
    on: (event: string, h: never) => {
      if (event === "tool_call") handler = h;
      return () => {};
    },
    getAllTools: () => [{ name: "infra_exec", exposure: "direct" }],
    getActiveTools: () => ["infra_exec"],
  } as never);

  if (!handler) throw new Error("the extension registered no tool_call handler");
  const call = (event: CallEvent) => handler!(event, { signal: undefined });
  return { call, requests };
}

describe("Telegram tool approval gate  critical security", () => {
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

  describe("an 'ask' tool blocks until the bot answers", () => {
    it("emits a request and passes once approved", async () => {
      const gate = makeGate({ infra_exec: "ask" }, "session-tg-ask");
      const promise = gate.call({
        toolName: "infra_exec",
        toolCallId: "tc-1",
        input: { id: "machine-1", command: "uname -a" },
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(gate.requests).toHaveLength(1);
      expect(gate.requests[0]).toMatchObject({
        toolName: "infra_exec",
        sessionId: "session-tg-ask",
      });

      await resolveApproval("session-tg-ask", "tc-1", true);
      expect(await promise).toBeUndefined();
    });

    it("blocks when the bot's button says no", async () => {
      const gate = makeGate({ infra_exec: "ask" }, "session-tg-deny");
      const promise = gate.call({ toolName: "infra_exec", toolCallId: "tc-2", input: {} });

      await vi.advanceTimersByTimeAsync(50);
      await resolveApproval("session-tg-deny", "tc-2", false);
      expect(await promise).toEqual({ block: true, reason: expect.stringContaining("denied") });
    });

    it("blocks when nobody answers before the window closes", async () => {
      const gate = makeGate({ infra_exec: "ask" }, "session-tg-timeout");
      const promise = gate.call({ toolName: "infra_exec", toolCallId: "tc-3", input: {} });

      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + 1_000);
      expect(await promise).toEqual({ block: true, reason: expect.stringContaining("denied") });
    });
  });

  describe("policies the bot cannot talk its way past", () => {
    it("blocks an 'off' tool without asking", async () => {
      const gate = makeGate({ infra_exec: "off" }, "session-tg-off");
      expect(await gate.call({ toolName: "infra_exec", toolCallId: "tc-4", input: {} })).toEqual({
        block: true,
        reason: expect.stringContaining("disabled"),
      });
      expect(gate.requests).toHaveLength(0);
    });

    it("runs an 'allow' tool without asking", async () => {
      const gate = makeGate({ infra_exec: "allow" }, "session-tg-allow");
      expect(
        await gate.call({ toolName: "infra_exec", toolCallId: "tc-5", input: {} }),
      ).toBeUndefined();
      expect(gate.requests).toHaveLength(0);
    });

    it("honours a user turning an 'allow' default into 'ask'", async () => {
      const gate = makeGate({ read: "ask" }, "session-tg-override");
      const promise = gate.call({ toolName: "read", toolCallId: "tc-6", input: { filePath: "a" } });

      await vi.advanceTimersByTimeAsync(50);
      expect(gate.requests).toHaveLength(1);
      await resolveApproval("session-tg-override", "tc-6", true);
      expect(await promise).toBeUndefined();
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
