import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  wrapWithApprovalGate,
  resolveApproval,
  type ApprovalRequest,
} from "@/lib/pi/tool-approval-gate";
import {
  enableAutoApprove,
  disableAutoApprove,
  isAutoApproveActive,
  getAutoApproveExpiry,
  STFU_DURATION_MS,
} from "@/lib/pi/auto-approve";

// The approval gate persists requests in Redis — use the in-memory stand-in.
vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));
import { resetMockRedis } from "../../helpers/in-memory-redis";

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
    parameters: {} as never,
    execute: async () => executeFn(),
  } as unknown as ToolDefinition;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolResult = any;

describe("auto-approve (/stfu) module", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockRedis();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is inactive by default", async () => {
    expect(await isAutoApproveActive("user-1")).toBe(false);
    expect(await getAutoApproveExpiry("user-1")).toBeNull();
  });

  it("enableAutoApprove activates the flag for the default 2h window", async () => {
    const now = Date.now();
    const expiry = await enableAutoApprove("user-1");

    expect(await isAutoApproveActive("user-1")).toBe(true);
    expect(expiry).toBeGreaterThan(now);
    expect(expiry - now).toBe(STFU_DURATION_MS);
    expect(await getAutoApproveExpiry("user-1")).toBe(expiry);
  });

  it("honours a custom duration", async () => {
    const now = Date.now();
    const expiry = await enableAutoApprove("user-1", 30 * 60 * 1000);

    expect(expiry - now).toBe(30 * 60 * 1000);
    expect(await isAutoApproveActive("user-1")).toBe(true);
  });

  it("auto-expires when the Redis TTL elapses (2h later)", async () => {
    await enableAutoApprove("user-1");
    expect(await isAutoApproveActive("user-1")).toBe(true);

    // Advance just past the 2h window — the Redis entry expires with its TTL.
    await vi.advanceTimersByTimeAsync(STFU_DURATION_MS + 60_000);
    expect(await isAutoApproveActive("user-1")).toBe(false);
    expect(await getAutoApproveExpiry("user-1")).toBeNull();
  });

  it("disableAutoApprove cancels the flag early", async () => {
    await enableAutoApprove("user-1");
    await disableAutoApprove("user-1");

    expect(await isAutoApproveActive("user-1")).toBe(false);
    expect(await getAutoApproveExpiry("user-1")).toBeNull();
  });

  it("is scoped per user", async () => {
    await enableAutoApprove("user-1");

    expect(await isAutoApproveActive("user-1")).toBe(true);
    expect(await isAutoApproveActive("user-2")).toBe(false);
  });
});

describe("approval gate honours auto-approve (/stfu)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockRedis();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes an 'ask'-policy tool immediately without an approval request", async () => {
    let executed = false;
    const emittedRequests: ApprovalRequest[] = [];

    await enableAutoApprove("user-1");

    const tool = wrapWithApprovalGate(
      makeMockTool("infra_exec", async () => {
        executed = true;
        return { content: [{ type: "text", text: "ok" }], details: {} };
      }),
      "user-1",
      "session-stfu-ask",
      async () => "ask",
      (request) => {
        emittedRequests.push(request);
      },
    );

    const result = (await tool.execute(
      "tc-1",
      {},
      undefined,
      undefined,
      {} as never,
    )) as ToolResult;

    expect(executed).toBe(true);
    expect(emittedRequests).toHaveLength(0);
    expect(result.content[0].text).toBe("ok");
  });

  it("overrides the 'off' policy (disabled tools run during STFU)", async () => {
    let executed = false;

    await enableAutoApprove("user-1");

    const tool = wrapWithApprovalGate(
      makeMockTool("infra_exec", async () => {
        executed = true;
        return { content: [{ type: "text", text: "ok" }], details: {} };
      }),
      "user-1",
      "session-stfu-off",
      async () => "off",
      () => {},
    );

    const result = (await tool.execute(
      "tc-2",
      {},
      undefined,
      undefined,
      {} as never,
    )) as ToolResult;

    expect(executed).toBe(true);
    expect(result.content[0].text).toBe("ok");
  });

  it("stops auto-approving after the window expires", async () => {
    let executed = false;
    const emittedRequests: ApprovalRequest[] = [];

    await enableAutoApprove("user-1");
    await vi.advanceTimersByTimeAsync(STFU_DURATION_MS + 60_000);

    const tool = wrapWithApprovalGate(
      makeMockTool("infra_exec", async () => {
        executed = true;
        return { content: [{ type: "text", text: "ok" }], details: {} };
      }),
      "user-1",
      "session-stfu-expired",
      async () => "ask",
      (request) => {
        emittedRequests.push(request);
      },
    );

    const promise = tool.execute("tc-3", {}, undefined, undefined, {} as never);
    await vi.advanceTimersByTimeAsync(50);

    expect(executed).toBe(false);
    expect(emittedRequests).toHaveLength(1);

    await resolveApproval("session-stfu-expired", "tc-3", true);
    await promise;
    expect(executed).toBe(true);
  });

  it("is scoped to the user who enabled it", async () => {
    let executed = false;
    const emittedRequests: ApprovalRequest[] = [];

    await enableAutoApprove("user-1");

    // Another user's tools still require approval.
    const tool = wrapWithApprovalGate(
      makeMockTool("infra_exec", async () => {
        executed = true;
        return { content: [{ type: "text", text: "ok" }], details: {} };
      }),
      "user-2",
      "session-stfu-other",
      async () => "ask",
      (request) => {
        emittedRequests.push(request);
      },
    );

    const promise = tool.execute("tc-4", {}, undefined, undefined, {} as never);
    await vi.advanceTimersByTimeAsync(50);

    expect(executed).toBe(false);
    expect(emittedRequests).toHaveLength(1);

    // Resolve the outstanding approval so the pending execute settles.
    await resolveApproval("session-stfu-other", "tc-4", false);
    await promise;
  });
});
