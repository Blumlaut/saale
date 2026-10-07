import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interruptPendingApprovals } from "@/lib/chat/approval-interrupt";
import { get } from "@/lib/pi/agent-pool";
import { getPendingApprovals, resolveApproval } from "@/lib/pi/tool-approval-gate";
import { readImageAsBase64 } from "@/lib/image-attachment";

vi.mock("@/lib/pi/agent-pool", () => ({
  get: vi.fn(),
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
}));

vi.mock("@/lib/pi/tool-approval-gate", () => ({
  getPendingApprovals: vi.fn(),
  resolveApproval: vi.fn(),
}));

vi.mock("@/lib/image-attachment", () => ({
  readImageAsBase64: vi.fn(),
}));

const mockGet = vi.mocked(get);
const mockPending = vi.mocked(getPendingApprovals);
const mockResolve = vi.mocked(resolveApproval);
const mockReadImage = vi.mocked(readImageAsBase64);

function makeApproval(toolCallId: string) {
  return { toolCallId, toolName: "bash", sessionId: "s1", userId: "u1" } as never;
}

function makePooledSession(steer?: ReturnType<typeof vi.fn>) {
  return {
    session: {
      isStreaming: true,
      steer: steer ?? vi.fn().mockResolvedValue(undefined),
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("interruptPendingApprovals", () => {
  it("returns null when nothing is pending and never touches the agent", async () => {
    mockPending.mockResolvedValue([]);

    const mode = await interruptPendingApprovals({
      userId: "u1",
      sessionId: "s1",
      content: "do this instead",
    });

    expect(mode).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("denies every pending approval and steers the message into the streaming session", async () => {
    mockPending.mockResolvedValue([makeApproval("tc1"), makeApproval("tc2")]);
    mockResolve.mockResolvedValue(true);
    const steer = vi.fn().mockResolvedValue(undefined);
    mockGet.mockReturnValue(makePooledSession(steer));

    const mode = await interruptPendingApprovals({
      userId: "u1",
      sessionId: "s1",
      content: "do this instead",
    });

    expect(mode).toBe("steered");
    expect(mockResolve).toHaveBeenCalledTimes(2);
    expect(mockResolve).toHaveBeenNthCalledWith(1, "s1", "tc1", false);
    expect(mockResolve).toHaveBeenNthCalledWith(2, "s1", "tc2", false);
    // Denials are settled before the steer is injected.
    expect(steer).toHaveBeenCalledWith("do this instead");
    expect(mockGet).toHaveBeenCalledWith("u1:s1");
  });

  it("steers image attachments as vision content", async () => {
    mockPending.mockResolvedValue([makeApproval("tc1")]);
    const steer = vi.fn().mockResolvedValue(undefined);
    mockGet.mockReturnValue(makePooledSession(steer));
    mockReadImage.mockResolvedValue({ data: "BASE64", mimeType: "image/png" });

    const mode = await interruptPendingApprovals({
      userId: "u1",
      sessionId: "s1",
      content: "look at this",
      attachments: [
        { storagePath: "files/abc-screenshot.png", mimeType: "image/png" },
        { storagePath: "files/abc-report.pdf", mimeType: "application/pdf" },
      ],
    });

    expect(mode).toBe("steered");
    expect(steer).toHaveBeenCalledWith("look at this", [
      { type: "image", data: "BASE64", mimeType: "image/png" },
    ]);
    // The PDF is referenced by path in the content — never decoded.
    expect(mockReadImage).toHaveBeenCalledTimes(1);
    expect(mockReadImage).toHaveBeenCalledWith("u1", "files/abc-screenshot.png");
  });

  it("falls back to the queue when the agent is not pooled in this process", async () => {
    mockPending.mockResolvedValue([makeApproval("tc1")]);
    mockResolve.mockResolvedValue(true);
    mockGet.mockReturnValue(undefined);

    const mode = await interruptPendingApprovals({
      userId: "u1",
      sessionId: "s1",
      content: "do this instead",
    });

    expect(mode).toBe("queued");
    expect(mockResolve).toHaveBeenCalledWith("s1", "tc1", false);
  });

  it("falls back to the queue when the pooled session is not streaming", async () => {
    mockPending.mockResolvedValue([makeApproval("tc1")]);
    mockGet.mockReturnValue({ session: { isStreaming: false, steer: vi.fn() } } as never);

    const mode = await interruptPendingApprovals({
      userId: "u1",
      sessionId: "s1",
      content: "do this instead",
    });

    expect(mode).toBe("queued");
    expect(mockResolve).toHaveBeenCalledWith("s1", "tc1", false);
  });

  it("falls back to the queue when the steer fails — the denials still stand", async () => {
    mockPending.mockResolvedValue([makeApproval("tc1")]);
    mockGet.mockReturnValue(makePooledSession(vi.fn().mockRejectedValue(new Error("boom"))));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mode = await interruptPendingApprovals({
      userId: "u1",
      sessionId: "s1",
      content: "do this instead",
    });

    expect(mode).toBe("queued");
    expect(mockResolve).toHaveBeenCalledWith("s1", "tc1", false);
    expect(spy).toHaveBeenCalled();
  });

  it("skips a failing image read instead of aborting the steer", async () => {
    mockPending.mockResolvedValue([makeApproval("tc1")]);
    const steer = vi.fn().mockResolvedValue(undefined);
    mockGet.mockReturnValue(makePooledSession(steer));
    mockReadImage.mockRejectedValue(new Error("file gone"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mode = await interruptPendingApprovals({
      userId: "u1",
      sessionId: "s1",
      content: "look at this",
      attachments: [{ storagePath: "files/abc-screenshot.png", mimeType: "image/png" }],
    });

    expect(mode).toBe("steered");
    expect(steer).toHaveBeenCalledWith("look at this");
    expect(spy).toHaveBeenCalled();
  });
});
