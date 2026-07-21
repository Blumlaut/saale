import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// Mock dependencies
vi.mock("@/lib/auth", () => ({}));

vi.mock("@/lib/db", () => ({
  prisma: {
    providerApiKey: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(),
  },
}));

vi.mock("@/app/api/admin/settings/auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/pi/models", () => ({
  fetchOpenAIModels: vi.fn(),
}));

import * as db from "@/lib/db";
import * as crypto from "@/lib/crypto";
import * as pi from "@earendil-works/pi-coding-agent";
import * as adminAuth from "@/app/api/admin/settings/auth";
import * as piModels from "@/lib/pi/models";
import { GET } from "@/app/api/admin/providers/models/route";

describe("GET /api/admin/providers/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ── Auth ── */

  it("returns 401 when not authenticated as admin", async () => {
    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await GET();
    expect(response.status).toBe(401);
  });

  /* ── Model listing ── */

  it("returns models from global providers", async () => {
    const mockModelRuntime = {
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
      getAvailableSnapshot: vi.fn().mockReturnValue([
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
        },
        {
          provider: "openai",
          id: "gpt-4o",
          name: "GPT-4o",
        },
      ]),
      getProvider: vi.fn().mockImplementation((id: string) => ({
        id,
        name: id === "anthropic" ? "Anthropic" : "OpenAI",
      })),
      registerProvider: vi.fn(),
    };

    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      ok: true,
      user: { id: "admin-1" },
    });

    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([
      {
        id: "key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: null,
        provider: "anthropic",
        encryptedKey: "encrypted-key",
        label: "Anthropic Key",
        baseUrl: null,
      },
    ]);

    vi.mocked(crypto.decrypt).mockReturnValue("sk-ant-123");
    vi.mocked(pi.ModelRuntime.create).mockResolvedValue(mockModelRuntime as never);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.models.anthropic).toHaveLength(1);
    expect(body.models.anthropic[0]).toMatchObject({
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      reasoning: false,
    });
    expect(body.providers).toHaveLength(2);
  });

  it("detects reasoning models by ID pattern", async () => {
    const mockModelRuntime = {
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
      getAvailableSnapshot: vi.fn().mockReturnValue([
        {
          provider: "anthropic",
          id: "claude-3.5-sonnet-r1",
          name: "Claude Sonnet R1",
        },
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
        },
      ]),
      getProvider: vi.fn().mockReturnValue({
        id: "anthropic",
        name: "Anthropic",
      }),
      registerProvider: vi.fn(),
    };

    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      ok: true,
      user: { id: "admin-1" },
    });

    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([
      {
        id: "key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: null,
        provider: "anthropic",
        encryptedKey: "encrypted-key",
        label: "Anthropic Key",
        baseUrl: null,
      },
    ]);

    vi.mocked(crypto.decrypt).mockReturnValue("sk-ant-123");
    vi.mocked(pi.ModelRuntime.create).mockResolvedValue(mockModelRuntime as never);

    const response = await GET();
    const body = await response.json();

    const r1Model = body.models.anthropic.find((m: { id: string; reasoning: boolean }) =>
      m.id.includes("r1"),
    );
    expect(r1Model.reasoning).toBe(true);

    const normalModel = body.models.anthropic.find(
      (m: { id: string; reasoning: boolean }) => m.id === "claude-sonnet-4",
    );
    expect(normalModel.reasoning).toBe(false);
  });

  it("handles empty global providers", async () => {
    const mockModelRuntime = {
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
      getAvailableSnapshot: vi.fn().mockReturnValue([]),
      getProvider: vi.fn(),
      registerProvider: vi.fn(),
    };

    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      ok: true,
      user: { id: "admin-1" },
    });

    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([]);
    vi.mocked(pi.ModelRuntime.create).mockResolvedValue(mockModelRuntime as never);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.models).toEqual({});
    expect(body.providers).toEqual([]);
  });

  it("handles decryption failure gracefully", async () => {
    const mockModelRuntime = {
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
      getAvailableSnapshot: vi.fn().mockReturnValue([]),
      getProvider: vi.fn(),
      registerProvider: vi.fn(),
    };

    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      ok: true,
      user: { id: "admin-1" },
    });

    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([
      {
        id: "key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: null,
        provider: "anthropic",
        encryptedKey: "corrupt",
        label: "Anthropic Key",
        baseUrl: null,
      },
    ]);

    vi.mocked(crypto.decrypt).mockImplementation(() => {
      throw new Error("Invalid encrypted data");
    });
    vi.mocked(pi.ModelRuntime.create).mockResolvedValue(mockModelRuntime as never);

    const response = await GET();
    expect(response.status).toBe(200);
  });

  it("handles decryption errors without crashing", async () => {
    const mockModelRuntime = {
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
      getAvailableSnapshot: vi.fn().mockReturnValue([]),
      getProvider: vi.fn(),
      registerProvider: vi.fn(),
    };

    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      ok: true,
      user: { id: "admin-1" },
    });

    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([
      {
        id: "key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: null,
        provider: "anthropic",
        encryptedKey: "bad",
        label: "Anthropic Key",
        baseUrl: null,
      },
    ]);

    vi.mocked(crypto.decrypt).mockImplementation(() => {
      throw new Error("Decryption failed");
    });
    vi.mocked(pi.ModelRuntime.create).mockResolvedValue(mockModelRuntime as never);

    const response = await GET();
    expect(response.status).toBe(200);
  });

  it("uses provider name from runtime, falls back to id", async () => {
    const mockModelRuntime = {
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
      getAvailableSnapshot: vi.fn().mockReturnValue([
        {
          provider: "custom",
          id: "custom-model",
          name: "Custom Model",
        },
      ]),
      getProvider: vi.fn().mockReturnValue(undefined),
      registerProvider: vi.fn(),
    };

    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      ok: true,
      user: { id: "admin-1" },
    });

    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([]);
    vi.mocked(pi.ModelRuntime.create).mockResolvedValue(mockModelRuntime as never);

    const response = await GET();
    const body = await response.json();

    const customProvider = body.providers.find((p: { id: string }) => p.id === "custom");
    expect(customProvider.name).toBe("custom"); // fallback to id
  });

  it("deduplicates discovered models with built-in models", async () => {
    const mockModelRuntime = {
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
      getAvailableSnapshot: vi.fn().mockReturnValue([
        {
          provider: "openrouter",
          id: "anthropic/claude-sonnet-4",
          name: "Anthropic: Claude Sonnet 4",
        },
      ]),
      getProvider: vi.fn().mockReturnValue({
        id: "openrouter",
        name: "OpenRouter",
      }),
      registerProvider: vi.fn(),
    };

    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      ok: true,
      user: { id: "admin-1" },
    });

    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([
      {
        id: "key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: null,
        provider: "openrouter",
        encryptedKey: "key",
        label: "OpenRouter Key",
        baseUrl: null,
      },
    ]);

    vi.mocked(crypto.decrypt).mockReturnValue("sk-or-123");
    vi.mocked(piModels.fetchOpenAIModels).mockResolvedValue([
      "anthropic/claude-sonnet-4", // same as built-in
      "anthropic/claude-opus-4", // new
    ]);
    vi.mocked(pi.ModelRuntime.create).mockResolvedValue(mockModelRuntime as never);

    const response = await GET();
    expect(response.status).toBe(200);
  });
});
