import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const mockDeviceId = vi.fn();
const mockAutoApprove = vi.fn();

vi.mock("@/lib/devices/client", () => ({
  resolveChatDeviceId: (...args: unknown[]) => mockDeviceId(...args),
}));

vi.mock("@/lib/pi/auto-approve", () => ({
  isAutoApproveActive: (...args: unknown[]) => mockAutoApprove(...args),
}));

import { createToolApprovalExtension } from "@/lib/pi/tool-approval-extension";

const DEVICE = { id: "dev-1", name: "workstation" };
const TOOL = "mcp__workstation__screenshot";

/** Capture the `tool_call` handler the extension registers. */
function captureHandler(options: Parameters<typeof createToolApprovalExtension>[0]) {
  let handler: ((event: unknown, ctx: { signal?: AbortSignal }) => Promise<unknown>) | undefined;

  const pi = {
    on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (event === "tool_call") handler = fn as typeof handler;
    },
    getAllTools: () => [],
  } as unknown as ExtensionAPI;

  createToolApprovalExtension(options)(pi);

  return (event: { toolName: string; toolCallId: string; input?: Record<string, unknown> }) =>
    handler!(event, {});
}

const baseOptions = {
  userId: "user-1",
  sessionId: "session-1",
  toolPolicies: null,
  mcpServerPolicies: { workstation: "allow" as const },
  emitApprovalRequest: () => {},
};

describe("the device gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAutoApprove.mockResolvedValue(false);
  });

  it("blocks a computer tool once the newest message came from elsewhere", async () => {
    mockDeviceId.mockResolvedValue(null);
    const call = captureHandler({ ...baseOptions, device: DEVICE });

    const outcome = await call({ toolName: TOOL, toolCallId: "call-1", input: {} });

    expect(outcome).toMatchObject({ block: true });
    expect((outcome as { reason: string }).reason).toContain("workstation");
  });

  it("blocks it even with auto-approve on", async () => {
    mockAutoApprove.mockResolvedValue(true);
    mockDeviceId.mockResolvedValue("someone-else");
    const call = captureHandler({ ...baseOptions, device: DEVICE });

    const outcome = await call({ toolName: TOOL, toolCallId: "call-1", input: {} });

    expect(outcome).toMatchObject({ block: true });
  });

  it("lets it through while the newest message is from that computer", async () => {
    mockDeviceId.mockResolvedValue(DEVICE.id);
    const call = captureHandler({ ...baseOptions, device: DEVICE });

    const outcome = await call({ toolName: TOOL, toolCallId: "call-1", input: {} });

    expect(outcome).toBeUndefined();
  });

  it("leaves a chat without a computer alone", async () => {
    const call = captureHandler({
      ...baseOptions,
      device: null,
      mcpServerPolicies: { homeassistant: "allow" },
    });

    const outcome = await call({
      toolName: "mcp__homeassistant__turn_on",
      toolCallId: "call-1",
      input: {},
    });

    expect(outcome).toBeUndefined();
    expect(mockDeviceId).not.toHaveBeenCalled();
  });
});
