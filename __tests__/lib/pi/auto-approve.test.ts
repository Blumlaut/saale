import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The approval gate persists requests in Redis  use the in-memory stand-in.
vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));
import { resetMockRedis } from "../../helpers/in-memory-redis";
import { createToolApprovalExtension } from "@/lib/pi/tool-approval-extension";
import { resolveApproval, type ApprovalRequest } from "@/lib/pi/tool-approval-gate";
import {
  enableAutoApprove,
  disableAutoApprove,
  isAutoApproveActive,
  getAutoApproveExpiry,
  STFU_DURATION_MS,
} from "@/lib/pi/auto-approve";

interface CallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/**
 * The session's gate, as Pi runs it: the handler decides, and the caller
 * executes the tool when it returns no block.
 */
function makeGate(options: {
  sessionId: string;
  toolPolicies: Record<string, string>;
  userId?: string;
  onRequest?: (request: ApprovalRequest) => void;
}) {
  let handler:
    ((event: CallEvent, ctx: { signal?: AbortSignal | undefined }) => Promise<unknown>) | null =
    null;
  const requests: ApprovalRequest[] = [];

  createToolApprovalExtension({
    userId: options.userId ?? "user-1",
    sessionId: options.sessionId,
    toolPolicies: options.toolPolicies,
    emitApprovalRequest: (request) => {
      requests.push(request);
      options.onRequest?.(request);
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

describe("auto-approve (/stfu) module", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockRedis();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports an expiry and clears the flag early", async () => {
    expect(await getAutoApproveExpiry("user-1")).toBeNull();
    const expiry = await enableAutoApprove("user-1");
    expect(await isAutoApproveActive("user-1")).toBe(true);
    expect(await getAutoApproveExpiry("user-1")).toBe(expiry);

    await disableAutoApprove("user-1");
    expect(await isAutoApproveActive("user-1")).toBe(false);
  });

  it("expires on its own", async () => {
    await enableAutoApprove("user-1");
    await vi.advanceTimersByTimeAsync(STFU_DURATION_MS + 1_000);
    expect(await isAutoApproveActive("user-1")).toBe(false);
  });

  it("runs an 'ask' tool without a request while active", async () => {
    await enableAutoApprove("user-1");
    const gate = makeGate({ sessionId: "session-stfu-ask", toolPolicies: { infra_exec: "ask" } });

    expect(
      await gate.call({ toolName: "infra_exec", toolCallId: "tc-1", input: {} }),
    ).toBeUndefined();
    expect(gate.requests).toHaveLength(0);
  });

  it("does not re-enable an 'off' tool", async () => {
    await enableAutoApprove("user-1");
    const gate = makeGate({ sessionId: "session-stfu-off", toolPolicies: { infra_exec: "off" } });

    expect(await gate.call({ toolName: "infra_exec", toolCallId: "tc-2", input: {} })).toEqual({
      block: true,
      reason: expect.stringContaining("disabled"),
    });
    expect(gate.requests).toHaveLength(0);
  });

  it("asks again once the window has expired", async () => {
    await enableAutoApprove("user-1");
    await vi.advanceTimersByTimeAsync(STFU_DURATION_MS + 60_000);
    const gate = makeGate({
      sessionId: "session-stfu-expired",
      toolPolicies: { infra_exec: "ask" },
    });

    const promise = gate.call({ toolName: "infra_exec", toolCallId: "tc-3", input: {} });
    await vi.advanceTimersByTimeAsync(50);
    expect(gate.requests).toHaveLength(1);

    await resolveApproval("session-stfu-expired", "tc-3", true);
    expect(await promise).toBeUndefined();
  });

  it("accepts a risky command under the 'auto' policy while active", async () => {
    await enableAutoApprove("user-1");
    const gate = makeGate({ sessionId: "session-stfu-auto", toolPolicies: { bash: "auto" } });

    expect(
      await gate.call({ toolName: "bash", toolCallId: "tc-5", input: { command: "rm -rf /" } }),
    ).toBeUndefined();
    expect(gate.requests).toHaveLength(0);
  });

  it("is scoped to the user who enabled it", async () => {
    await enableAutoApprove("user-1");
    const gate = makeGate({
      sessionId: "session-stfu-other",
      toolPolicies: { infra_exec: "ask" },
      userId: "user-2",
    });

    const promise = gate.call({ toolName: "infra_exec", toolCallId: "tc-4", input: {} });
    await vi.advanceTimersByTimeAsync(50);
    expect(gate.requests).toHaveLength(1);

    await resolveApproval("session-stfu-other", "tc-4", false);
    expect(await promise).toEqual({ block: true, reason: expect.stringContaining("denied") });
  });
});
