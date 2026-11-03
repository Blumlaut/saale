import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The worker secret is read at module scope, so it must be set before import.
process.env.WORKER_API_KEY = "test-worker-secret";

/**
 * The daily coder sweep, as the worker calls it.
 *
 * Its one rule is that a stopped container is left alone: nothing about the pass
 * is worth starting a workspace nobody is using.
 */

const mocks = vi.hoisted(() => ({
  listContainers: vi.fn(),
  isConfigured: vi.fn(),
  sweepOrphanProcesses: vi.fn(),
}));

vi.mock("@/lib/sandbox/client", () => ({
  isConfigured: mocks.isConfigured,
  listContainers: mocks.listContainers,
}));

vi.mock("@/lib/coder/process-sweep", () => ({
  sweepOrphanProcesses: mocks.sweepOrphanProcesses,
}));

import { POST } from "@/app/api/coder/sweep/route";

function makeRequest(key = "test-worker-secret") {
  return new NextRequest("http://localhost/api/coder/sweep", {
    method: "POST",
    headers: { "x-worker-key": key },
  });
}

const container = (identity: string, state: string) => ({ identity, state, createdAt: 1 });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isConfigured.mockReturnValue(true);
  mocks.listContainers.mockResolvedValue([container("user-aaaa", "running")]);
  mocks.sweepOrphanProcesses.mockResolvedValue({ stopped: [], live: 0 });
});

describe("POST /api/coder/sweep", () => {
  it("refuses a request without the worker key", async () => {
    const response = await POST(makeRequest(""));

    expect(response.status).toBe(401);
    expect(mocks.listContainers).not.toHaveBeenCalled();
  });

  it("hands the sweep only the workspaces that are running", async () => {
    mocks.listContainers.mockResolvedValue([
      container("user-running", "running"),
      container("user-stopped", "exited"),
      container("user-new", "created"),
    ]);

    const response = await POST(makeRequest());

    const passed = mocks.sweepOrphanProcesses.mock.calls[0]?.[0] as Set<string>;
    expect([...passed]).toEqual(["user-running"]);
    expect(response.status).toBe(200);
  });

  it("reports the sweep's result", async () => {
    mocks.sweepOrphanProcesses.mockResolvedValue({ stopped: ["chat-1"], live: 2 });

    const response = await POST(makeRequest());

    expect(await response.json()).toEqual({
      success: true,
      processes: { stopped: ["chat-1"], live: 2 },
    });
  });

  it("looks for no containers without a sandbox", async () => {
    mocks.isConfigured.mockReturnValue(false);

    const response = await POST(makeRequest());

    expect(await response.json()).toEqual({
      success: true,
      processes: { stopped: [], live: 0 },
    });
    expect(mocks.listContainers).not.toHaveBeenCalled();
    expect(mocks.sweepOrphanProcesses).not.toHaveBeenCalled();
  });

  it("answers with a failure when the sandbox cannot be listed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listContainers.mockRejectedValue(new Error("sandbox is down"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
