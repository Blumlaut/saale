import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Mock dependencies
vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: vi.fn(),
}));

import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as models from "@/lib/pi/models";
import { GET } from "@/app/api/providers/models/route";

describe("GET /api/providers/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ── Auth ── */

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const request = new NextRequest("http://localhost/api/providers/models");
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  /* ── Model listing ── */

  it("returns models grouped by provider", async () => {
    const mockModelRuntime = {
      getProvider: vi.fn().mockImplementation((id: string) => ({
        id,
        name: id === "anthropic" ? "Anthropic" : "OpenAI",
      })),
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: mockModelRuntime as never,
      models: [
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          reasoning: false,
          contextWindow: 200_000,
          vision: true,
        },
        {
          provider: "anthropic",
          id: "claude-opus-4",
          name: "Claude Opus 4",
          reasoning: false,
          contextWindow: 200_000,
          vision: true,
        },
        {
          provider: "openai",
          id: "gpt-4o",
          name: "GPT-4o",
          reasoning: false,
          contextWindow: 200_000,
          vision: false,
        },
      ],
    });

    vi.mocked(db.prisma.appSettings.findUnique).mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/providers/models");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.providers).toHaveLength(2);
    expect(body.providers[0]).toMatchObject({
      id: "anthropic",
      name: "Anthropic",
      modelCount: 2,
    });
    expect(body.providers[1]).toMatchObject({
      id: "openai",
      name: "OpenAI",
      modelCount: 1,
    });
    expect(body.totalModels).toBe(3);
    expect(body.models.anthropic).toHaveLength(2);
    expect(body.models.openai).toHaveLength(1);

    // Pickers badge image support with this; without it a vision model looked
    // the same as one that drops every image.
    expect(body.models.anthropic[0]).toMatchObject({ vision: true });
    expect(body.models.openai[0]).toMatchObject({ vision: false });
    // Catalog-backed providers are Pi's to describe, so nothing is editable here.
    expect(body.providers[0]).toMatchObject({ modelsConfigurable: false });
  });

  it("marks the providers whose models Saale defines as configurable", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });
    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: {
        getProvider: vi.fn().mockReturnValue({ id: "custom", name: "OpenAI-compatible" }),
      } as never,
      models: [
        {
          provider: "custom",
          id: "Qwen3-VL-8B",
          name: "Qwen3-VL-8B",
          reasoning: false,
          contextWindow: 32_768,
          vision: true,
        },
      ],
    });
    vi.mocked(db.prisma.appSettings.findUnique).mockResolvedValue(null);

    const response = await GET(new NextRequest("http://localhost/api/providers/models"));
    const body = await response.json();

    expect(body.providers[0]).toMatchObject({ id: "custom", modelsConfigurable: true });
    expect(body.models.custom[0]).toMatchObject({ vision: true, contextWindow: 32_768 });
  });

  it("excludes disabled models by default", async () => {
    const mockModelRuntime = {
      getProvider: vi.fn().mockImplementation((id: string) => ({
        id,
        name: id,
      })),
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: mockModelRuntime as never,
      models: [
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          reasoning: false,
          contextWindow: 200_000,
          vision: false,
        },
        {
          provider: "anthropic",
          id: "claude-opus-4",
          name: "Claude Opus 4",
          reasoning: false,
          contextWindow: 200_000,
          vision: false,
        },
        {
          provider: "openai",
          id: "gpt-4o",
          name: "GPT-4o",
          reasoning: false,
          contextWindow: 200_000,
          vision: false,
        },
      ],
    });

    vi.mocked(db.prisma.appSettings.findUnique).mockResolvedValue({
      disabledModels: ["anthropic:claude-opus-4"],
    } as never);

    const request = new NextRequest("http://localhost/api/providers/models");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.totalModels).toBe(2);
    expect(body.models.anthropic).toHaveLength(1);
    expect(body.models.anthropic[0].id).toBe("claude-sonnet-4");
    expect(body.disabledModels).toEqual(["anthropic:claude-opus-4"]);
  });

  it("includes disabled models when ?includeDisabled=true", async () => {
    const mockModelRuntime = {
      getProvider: vi.fn().mockImplementation((id: string) => ({
        id,
        name: id,
      })),
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: mockModelRuntime as never,
      models: [
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          reasoning: false,
          contextWindow: 200_000,
          vision: false,
        },
        {
          provider: "anthropic",
          id: "claude-opus-4",
          name: "Claude Opus 4",
          reasoning: false,
          contextWindow: 200_000,
          vision: false,
        },
      ],
    });

    vi.mocked(db.prisma.appSettings.findUnique).mockResolvedValue({
      disabledModels: ["anthropic:claude-opus-4"],
    } as never);

    const request = new NextRequest("http://localhost/api/providers/models?includeDisabled=true");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.totalModels).toBe(2);
    expect(body.models.anthropic).toHaveLength(2);
  });

  it("returns empty list when no models available", async () => {
    const mockModelRuntime = {
      getProvider: vi.fn(),
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: mockModelRuntime as never,
      models: [],
    });

    vi.mocked(db.prisma.appSettings.findUnique).mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/providers/models");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.providers).toEqual([]);
    expect(body.models).toEqual({});
    expect(body.totalModels).toBe(0);
    expect(body.disabledModels).toEqual([]);
  });

  it("uses provider name from runtime, falls back to provider id", async () => {
    const mockModelRuntime = {
      getProvider: vi.fn().mockImplementation((id: string) => {
        if (id === "anthropic") return { id, name: "Anthropic" };
        return undefined; // unknown provider
      }),
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-1" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: mockModelRuntime as never,
      models: [
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          reasoning: false,
          contextWindow: 200_000,
          vision: false,
        },
        {
          provider: "custom-provider",
          id: "custom-model",
          name: "Custom Model",
          reasoning: false,
          contextWindow: 200_000,
          vision: false,
        },
      ],
    });

    vi.mocked(db.prisma.appSettings.findUnique).mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/providers/models");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();

    const anthropicProvider = body.providers.find((p: { id: string }) => p.id === "anthropic");
    expect(anthropicProvider.name).toBe("Anthropic");

    const customProvider = body.providers.find((p: { id: string }) => p.id === "custom-provider");
    expect(customProvider.name).toBe("custom-provider"); // fallback to id
  });

  it("calls buildModelRuntime with user ID", async () => {
    const mockModelRuntime = {
      getProvider: vi.fn(),
    };

    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: true,
      user: { id: "user-specific-789" },
    });

    vi.mocked(models.buildModelRuntime).mockResolvedValue({
      modelRuntime: mockModelRuntime as never,
      models: [],
    });

    vi.mocked(db.prisma.appSettings.findUnique).mockResolvedValue(null);

    const request = new NextRequest("http://localhost/api/providers/models");
    await GET(request);

    expect(models.buildModelRuntime).toHaveBeenCalledWith("user-specific-789");
  });
});
