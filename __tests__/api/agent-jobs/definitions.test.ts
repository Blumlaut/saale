import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    agentDefinition: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/queue", () => ({
  scheduleAgentDefinition: vi.fn().mockResolvedValue(undefined),
  unscheduleAgentDefinition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/agent-jobs/run", () => ({
  triggerAgentRun: vi.fn(),
}));

import * as auth from "@/lib/auth";
import { prisma } from "@/lib/db";
import { triggerAgentRun } from "@/lib/agent-jobs/run";
import { POST as createDefinition } from "@/app/api/agent-jobs/definitions/route";
import {
  PATCH as patchDefinition,
  DELETE as deleteDefinition,
} from "@/app/api/agent-jobs/definitions/[id]/route";
import { POST as triggerRun } from "@/app/api/agent-jobs/definitions/[id]/runs/route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAgentDefinition = prisma.agentDefinition as any;

function authAs(userId: string) {
  vi.mocked(auth.requireSession).mockResolvedValue({
    ok: true,
    user: { id: userId },
    response: null,
  } as never);
}

function jsonRequest(url: string, body: Record<string, unknown>, method = "POST") {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("System-managed agent definitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/agent-jobs/definitions", () => {
    it("rejects creating a job with the reserved Telegram Assistant name", async () => {
      authAs("user-1");

      const response = await createDefinition(
        jsonRequest("http://localhost/api/agent-jobs/definitions", {
          name: "Telegram Assistant",
          prompt: "Do a thing",
        }),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('"Telegram Assistant" is managed by Saale');
      expect(mockAgentDefinition.create).not.toHaveBeenCalled();
    });

    it("allows creating a job with any other name", async () => {
      authAs("user-1");
      mockAgentDefinition.create.mockResolvedValue({
        id: "def-1",
        name: "Daily Briefing",
        prompt: "Brief me",
        systemPrompt: null,
        toolConfig: null,
        modelId: null,
        thinkingLevel: "off",
        outputChannel: null,
        outputChannelId: null,
        cronExpression: null,
        lastRunAt: null,
        enabled: true,
        createdAt: new Date("2024-01-01T00:00:00Z"),
        updatedAt: new Date("2024-01-01T00:00:00Z"),
      });

      const response = await createDefinition(
        jsonRequest("http://localhost/api/agent-jobs/definitions", {
          name: "Daily Briefing",
          prompt: "Brief me",
        }),
      );

      expect(response.status).toBe(200);
      expect(mockAgentDefinition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: "Daily Briefing" }),
        }),
      );
    });
  });

  describe("PATCH /api/agent-jobs/definitions/:id", () => {
    const params = { params: Promise.resolve({ id: "def-tg" }) };

    it("rejects edits to a system-managed definition", async () => {
      authAs("user-1");
      mockAgentDefinition.findFirst.mockResolvedValue({
        id: "def-tg",
        userId: "user-1",
        systemManaged: true,
      });

      const response = await patchDefinition(
        jsonRequest(
          "http://localhost/api/agent-jobs/definitions/def-tg",
          { name: "New Name" },
          "PATCH",
        ),
        params,
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain("managed by Saale");
      expect(mockAgentDefinition.update).not.toHaveBeenCalled();
    });

    it("rejects renaming a normal definition to the reserved name", async () => {
      authAs("user-1");
      mockAgentDefinition.findFirst.mockResolvedValue({
        id: "def-1",
        userId: "user-1",
        systemManaged: false,
        modelId: null,
      });

      const response = await patchDefinition(
        jsonRequest(
          "http://localhost/api/agent-jobs/definitions/def-1",
          { name: "Telegram Assistant" },
          "PATCH",
        ),
        { params: Promise.resolve({ id: "def-1" }) },
      );

      expect(response.status).toBe(400);
      expect(mockAgentDefinition.update).not.toHaveBeenCalled();
    });

    it("allows editing a normal definition", async () => {
      authAs("user-1");
      mockAgentDefinition.findFirst.mockResolvedValue({
        id: "def-1",
        userId: "user-1",
        systemManaged: false,
        modelId: null,
      });
      mockAgentDefinition.update.mockResolvedValue({
        id: "def-1",
        name: "Renamed",
        description: null,
        prompt: "Brief me",
        systemPrompt: null,
        toolConfig: null,
        modelId: null,
        thinkingLevel: "off",
        outputChannel: null,
        outputChannelId: null,
        cronExpression: null,
        lastRunAt: null,
        enabled: true,
        systemManaged: false,
        createdAt: new Date("2024-01-01T00:00:00Z"),
        updatedAt: new Date("2024-01-01T00:00:00Z"),
      });

      const response = await patchDefinition(
        jsonRequest(
          "http://localhost/api/agent-jobs/definitions/def-1",
          { name: "Renamed" },
          "PATCH",
        ),
        { params: Promise.resolve({ id: "def-1" }) },
      );

      expect(response.status).toBe(200);
      expect(mockAgentDefinition.update).toHaveBeenCalled();
    });
  });

  describe("DELETE /api/agent-jobs/definitions/:id", () => {
    it("rejects deleting a system-managed definition", async () => {
      authAs("user-1");
      mockAgentDefinition.findFirst.mockResolvedValue({
        id: "def-tg",
        userId: "user-1",
        systemManaged: true,
      });

      const response = await deleteDefinition(
        new NextRequest("http://localhost/api/agent-jobs/definitions/def-tg", { method: "DELETE" }),
        { params: Promise.resolve({ id: "def-tg" }) },
      );

      expect(response.status).toBe(403);
      expect(mockAgentDefinition.delete).not.toHaveBeenCalled();
    });

    it("allows deleting a normal definition", async () => {
      authAs("user-1");
      mockAgentDefinition.findFirst.mockResolvedValue({
        id: "def-1",
        userId: "user-1",
        systemManaged: false,
      });
      mockAgentDefinition.delete.mockResolvedValue({});

      const response = await deleteDefinition(
        new NextRequest("http://localhost/api/agent-jobs/definitions/def-1", { method: "DELETE" }),
        { params: Promise.resolve({ id: "def-1" }) },
      );

      expect(response.status).toBe(200);
      expect(mockAgentDefinition.delete).toHaveBeenCalledWith({ where: { id: "def-1" } });
    });
  });

  describe("POST /api/agent-jobs/definitions/:id/runs", () => {
    it("rejects triggering a run on a system-managed definition", async () => {
      authAs("user-1");
      mockAgentDefinition.findFirst.mockResolvedValue({
        id: "def-tg",
        userId: "user-1",
        enabled: true,
        systemManaged: true,
      });

      const response = await triggerRun(
        new NextRequest("http://localhost/api/agent-jobs/definitions/def-tg/runs", {
          method: "POST",
        }),
        { params: Promise.resolve({ id: "def-tg" }) },
      );

      expect(response.status).toBe(403);
      expect(triggerAgentRun).not.toHaveBeenCalled();
    });

    it("allows triggering a run on a normal enabled definition", async () => {
      authAs("user-1");
      mockAgentDefinition.findFirst.mockResolvedValue({
        id: "def-1",
        userId: "user-1",
        enabled: true,
        systemManaged: false,
      });
      vi.mocked(triggerAgentRun).mockResolvedValue({
        id: "run-1",
        status: "pending",
        prompt: "Brief me",
        outputChannel: null,
        outputChannelId: null,
        createdAt: new Date(),
      });

      const response = await triggerRun(
        new NextRequest("http://localhost/api/agent-jobs/definitions/def-1/runs", {
          method: "POST",
        }),
        { params: Promise.resolve({ id: "def-1" }) },
      );

      expect(response.status).toBe(200);
      expect(triggerAgentRun).toHaveBeenCalledWith({
        definitionId: "def-1",
        userId: "user-1",
      });
    });
  });
});
