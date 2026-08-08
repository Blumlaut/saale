import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Set the worker secret before importing the route (it reads it at module scope)
process.env.WORKER_API_KEY = "test-worker-secret";

vi.mock("@/lib/db", () => ({
  prisma: {
    agentDefinition: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/agent-jobs/run", () => ({
  triggerAgentRun: vi.fn(),
}));

vi.mock("@/lib/queue", () => ({
  unscheduleAgentDefinition: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/db";
import { triggerAgentRun } from "@/lib/agent-jobs/run";
import { unscheduleAgentDefinition } from "@/lib/queue";
import { POST } from "@/app/api/agent-jobs/execute/route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAgentDefinitionFindUnique = vi.mocked(prisma.agentDefinition.findUnique as any);

function makeRequest(definitionId?: string, key = "test-worker-secret") {
  return new NextRequest("http://localhost/api/agent-jobs/execute", {
    method: "POST",
    headers: { "x-worker-key": key },
    body: JSON.stringify({ definitionId }),
  });
}

describe("POST /api/agent-jobs/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(triggerAgentRun).mockResolvedValue({
      id: "run-1",
      status: "pending",
      prompt: "Daily briefing",
      outputChannel: "telegram",
      outputChannelId: "12345",
      createdAt: new Date(),
    });
  });

  it("returns 401 without the worker key", async () => {
    const response = await POST(makeRequest("def-1", ""));
    expect(response.status).toBe(401);
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("returns 401 with the wrong worker key", async () => {
    const response = await POST(makeRequest("def-1", "wrong-key"));
    expect(response.status).toBe(401);
  });

  it("returns 400 when definitionId is missing", async () => {
    const response = await POST(makeRequest(undefined));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("definitionId is required");
  });

  it("triggers a run for an enabled definition and returns the run id", async () => {
    mockAgentDefinitionFindUnique.mockResolvedValue({
      id: "def-1",
      enabled: true,
      userId: "user-1",
    });

    const response = await POST(makeRequest("def-1"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ success: true, runId: "run-1" });

    expect(triggerAgentRun).toHaveBeenCalledWith({
      definitionId: "def-1",
      userId: "user-1",
    });
    expect(unscheduleAgentDefinition).not.toHaveBeenCalled();
  });

  it("removes the scheduler and skips when the definition was deleted", async () => {
    mockAgentDefinitionFindUnique.mockResolvedValue(null);

    const response = await POST(makeRequest("def-deleted"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ success: true, skipped: true });

    expect(unscheduleAgentDefinition).toHaveBeenCalledWith("def-deleted");
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("removes the scheduler and skips when the definition is disabled", async () => {
    mockAgentDefinitionFindUnique.mockResolvedValue({
      id: "def-1",
      enabled: false,
      userId: "user-1",
    });

    const response = await POST(makeRequest("def-1"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ success: true, skipped: true });

    expect(unscheduleAgentDefinition).toHaveBeenCalledWith("def-1");
    expect(triggerAgentRun).not.toHaveBeenCalled();
  });

  it("returns 500 when triggering the run fails", async () => {
    mockAgentDefinitionFindUnique.mockResolvedValue({
      id: "def-1",
      enabled: true,
      userId: "user-1",
    });
    vi.mocked(triggerAgentRun).mockRejectedValue(new Error("no model configured"));

    const response = await POST(makeRequest("def-1"));
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe("no model configured");
  });
});
