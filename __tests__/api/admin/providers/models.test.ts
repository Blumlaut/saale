import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/pi/models", () => ({
  // The admin list uses the unfiltered builder: it has to show models that are
  // currently switched off so they can be switched back on.
  buildAdminModelList: vi.fn(),
}));

vi.mock("@/lib/providers/endpoint", () => ({
  readEndpointRow: vi.fn(),
}));

import { requirePermission } from "@/lib/auth";
import * as piModels from "@/lib/pi/models";
import * as endpoint from "@/lib/providers/endpoint";
import { GET } from "@/app/api/admin/providers/models/route";

/** One model as `buildGlobalModelRuntime` reports it. */
function model(overrides: Record<string, unknown> = {}) {
  return {
    provider: "anthropic",
    id: "claude-sonnet",
    name: "Claude Sonnet",
    reasoning: true,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    vision: true,
    ...overrides,
  };
}

/** Stub the global runtime build with the models and provider names to report. */
function stubRuntime(models: ReturnType<typeof model>[], names: Record<string, string> = {}) {
  vi.mocked(piModels.buildAdminModelList).mockResolvedValue({
    models,
    modelRuntime: {
      getProvider: (id: string) => (names[id] ? { id, name: names[id] } : undefined),
    },
  } as never);
}

describe("GET /api/admin/providers/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue({
      ok: true,
      user: { id: "admin-1" },
    } as never);
    stubRuntime([]);
    vi.mocked(endpoint.readEndpointRow).mockResolvedValue(null);
  });

  it("returns 401 when the caller is not an admin", async () => {
    vi.mocked(requirePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(piModels.buildAdminModelList).not.toHaveBeenCalled();
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
      {
        id: "llama",
        name: "Llama",
        reasoning: false,
        vision: false,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
      {
        id: "qwen",
        name: "Qwen",
        reasoning: true,
        vision: false,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    ]);
  });

  it("reports the catalog's flags rather than guessing them from the id", async () => {
    // A model whose id contains "r1" used to be marked as a reasoner and every
    // model used to be marked text-only.
    stubRuntime([model({ id: "deepseek-r1-distill", reasoning: false, vision: true })]);

    const body = await (await GET()).json();

    expect(body.models.anthropic).toEqual([
      {
        id: "deepseek-r1-distill",
        name: "Claude Sonnet",
        reasoning: false,
        vision: true,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
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

  it("lists models of a provider that is switched off", async () => {
    // Re-enabling a model means finding it here first: this endpoint must not
    // apply the availability filter the user-facing one applies.
    stubRuntime([model({ provider: "groq", id: "llama" })], { groq: "Groq" });

    const body = await (await GET()).json();

    expect(body.models.groq).toEqual([
      {
        id: "llama",
        name: "Claude Sonnet",
        reasoning: true,
        vision: true,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    ]);
    expect(piModels.buildAdminModelList).toHaveBeenCalled();
  });

  it("reports a per-model limit override and the endpoint defaults behind it", async () => {
    stubRuntime(
      [
        model({
          provider: "custom",
          id: "local",
          contextWindow: 32_768,
          maxOutputTokens: 4_096,
        }),
      ],
      { custom: "OpenAI-compatible" },
    );
    vi.mocked(endpoint.readEndpointRow).mockResolvedValue({
      id: "key-1",
      userId: null,
      baseUrl: "http://localhost:8080/v1",
      encryptedKey: "enc()",
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      modelCapabilities: { local: { contextWindow: 32_768, maxOutputTokens: 4_096 } },
    });

    const body = await (await GET()).json();

    // The override is priced in, and the endpoint's defaults are available for
    // the fields a model leaves alone.
    expect(body.models.custom[0]).toMatchObject({
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      overrides: { contextWindow: 32_768, maxOutputTokens: 4_096 },
    });
    expect(body.endpointLimits).toEqual({ contextWindow: 131_072, maxOutputTokens: 8_192 });
  });

  it("returns an empty listing when the global configuration has no models", async () => {
    const body = await (await GET()).json();

    expect(body).toEqual({ models: {}, providers: [], endpointLimits: null });
  });
});
