import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/admin/settings/auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/pi/models", () => ({
  buildGlobalModelRuntime: vi.fn(),
}));

import * as adminAuth from "@/app/api/admin/settings/auth";
import * as piModels from "@/lib/pi/models";
import { GET } from "@/app/api/admin/providers/models/route";

/** One model as `buildGlobalModelRuntime` reports it. */
function model(overrides: Record<string, unknown> = {}) {
  return {
    provider: "anthropic",
    id: "claude-sonnet",
    name: "Claude Sonnet",
    reasoning: true,
    contextWindow: 200_000,
    vision: true,
    ...overrides,
  };
}

/** Stub the global runtime build with the models and provider names to report. */
function stubRuntime(models: ReturnType<typeof model>[], names: Record<string, string> = {}) {
  vi.mocked(piModels.buildGlobalModelRuntime).mockResolvedValue({
    models,
    modelRuntime: {
      getProvider: (id: string) => (names[id] ? { id, name: names[id] } : undefined),
    },
  } as never);
}

describe("GET /api/admin/providers/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      ok: true,
      user: { id: "admin-1" },
    } as never);
    stubRuntime([]);
  });

  it("returns 401 when the caller is not an admin", async () => {
    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(piModels.buildGlobalModelRuntime).not.toHaveBeenCalled();
  });

  it("groups the global configuration's models by provider", async () => {
    stubRuntime(
      [
        model(),
        model({ provider: "groq", id: "llama", name: "Llama", reasoning: false, vision: false }),
        model({ provider: "groq", id: "qwen", name: "Qwen", reasoning: true, vision: false }),
      ],
      { anthropic: "Anthropic", groq: "Groq" },
    );

    const body = await (await GET()).json();

    expect(body.providers).toEqual([
      { id: "anthropic", name: "Anthropic", modelCount: 1, modelsConfigurable: false },
      { id: "groq", name: "Groq", modelCount: 2, modelsConfigurable: false },
    ]);
    expect(body.models.groq).toEqual([
      { id: "llama", name: "Llama", reasoning: false, vision: false },
      { id: "qwen", name: "Qwen", reasoning: true, vision: false },
    ]);
  });

  it("reports the catalog's flags rather than guessing them from the id", async () => {
    // A model whose id contains "r1" used to be marked as a reasoner and every
    // model used to be marked text-only.
    stubRuntime([model({ id: "deepseek-r1-distill", reasoning: false, vision: true })]);

    const body = await (await GET()).json();

    expect(body.models.anthropic).toEqual([
      { id: "deepseek-r1-distill", name: "Claude Sonnet", reasoning: false, vision: true },
    ]);
  });

  it("marks Saale's own endpoint as configurable", async () => {
    stubRuntime([model({ provider: "custom", id: "local" })], { custom: "OpenAI-compatible" });

    const body = await (await GET()).json();

    expect(body.providers).toEqual([
      {
        id: "custom",
        name: "OpenAI-compatible",
        modelCount: 1,
        modelsConfigurable: true,
      },
    ]);
  });

  it("falls back to the provider id when the runtime has no name for it", async () => {
    stubRuntime([model({ provider: "some-new-provider" })]);

    const body = await (await GET()).json();

    expect(body.providers[0].name).toBe("some-new-provider");
  });

  it("returns an empty listing when the global configuration has no models", async () => {
    const body = await (await GET()).json();

    expect(body).toEqual({ models: {}, providers: [] });
  });
});
