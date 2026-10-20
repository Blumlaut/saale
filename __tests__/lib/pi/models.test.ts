import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    providerApiKey: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    adminSettings: {
      findUnique: vi.fn(),
    },
  },
}));

// Mock crypto
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(),
}));

// Mock ModelRuntime
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(),
  },
}));

vi.mock("@/lib/providers/models-store", () => ({
  createModelsStore: vi.fn(() => ({ kind: "models-store" })),
  refreshModelCatalogInBackground: vi.fn(),
}));

import * as db from "@/lib/db";
import * as crypto from "@/lib/crypto";
import * as pi from "@earendil-works/pi-coding-agent";
import * as modelsStore from "@/lib/providers/models-store";
import { buildAdminModelList, buildGlobalModelRuntime, buildModelRuntime } from "@/lib/pi/models";

/** Stub the `/models` listing an OpenAI-compatible endpoint returns. */
function stubModelListing(ids: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    }),
  );
}

/** One model as Pi's availability snapshot returns it. */
function catalogModel(overrides: Record<string, unknown> = {}) {
  return {
    provider: "anthropic",
    id: "claude-sonnet",
    name: "Claude Sonnet",
    reasoning: true,
    contextWindow: 200_000,
    input: ["text", "image"],
    ...overrides,
  };
}

/**
 * The user's OpenAI-compatible endpoint row, as the runtime reads it.
 * `stubEndpointRow()` with no argument means no endpoint at all.
 */
function stubEndpointRow(overrides?: Record<string, unknown>) {
  vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(
    (overrides === undefined
      ? null
      : {
          baseUrl: "http://localhost:8080/v1",
          encryptedKey: "enc(key-1)",
          contextWindow: null,
          maxOutputTokens: null,
          modelCapabilities: null,
          ...overrides,
        }) as never,
  );
}

/** The runtime the SDK would return, with only what Saale uses. */
function stubRuntime(overrides: Record<string, unknown> = {}) {
  const runtime = {
    getAvailableSnapshot: vi.fn().mockReturnValue([]),
    getModel: vi.fn(),
    setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
    getProvider: vi.fn(),
    registerProvider: vi.fn(),
    ...overrides,
  };
  vi.mocked(pi.ModelRuntime.create).mockResolvedValue(runtime as never);
  return runtime;
}

describe("buildModelRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();

    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([] as never);
    vi.mocked(db.prisma.providerApiKey.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.prisma.adminSettings.findUnique).mockResolvedValue(null);
    vi.mocked(crypto.decrypt).mockReturnValue("");

    stubRuntime();
  });

  it("creates a runtime", async () => {
    const result = await buildModelRuntime("user-1");

    expect(pi.ModelRuntime.create).toHaveBeenCalled();
    expect(result.modelRuntime).toBeDefined();
    expect(result.models).toEqual([]);
  });

  // The SDK's default runtime reads the host's ~/.pi/agent/{auth,models}.json.
  // On a server those belong to whoever installed Pi there, so a default
  // runtime would serve tenants the operator's keys and private endpoints.
  it("is built without the host's credential or catalog files", async () => {
    await buildModelRuntime("user-1");

    const options = vi.mocked(pi.ModelRuntime.create).mock.calls[0]![0] as {
      credentials?: unknown;
      modelsPath?: unknown;
    };
    expect(options.credentials).toMatchObject({
      read: expect.any(Function),
      list: expect.any(Function),
      modify: expect.any(Function),
      delete: expect.any(Function),
    });
    expect(options.modelsPath).toBeNull();
  });

  // Pi's own catalog refresh is what keeps a provider's model list current
  // without shipping a new package; Saale answers from the cached overlay and
  // refreshes it detached, so a fetch never delays a request.
  it("reads the shared catalog cache and refreshes it in the background", async () => {
    const runtime = stubRuntime();

    await buildModelRuntime("user-1");

    const options = vi.mocked(pi.ModelRuntime.create).mock.calls[0]![0] as {
      modelsStore?: unknown;
      allowModelNetwork?: unknown;
    };
    expect(options.modelsStore).toEqual({ kind: "models-store" });
    expect(options.allowModelNetwork).toBe(false);
    expect(modelsStore.refreshModelCatalogInBackground).toHaveBeenCalledWith(runtime);
  });

  it("carries what Pi's catalog knows about each model into the UI list", async () => {
    stubRuntime({
      getAvailableSnapshot: vi.fn().mockReturnValue([
        catalogModel(),
        catalogModel({
          provider: "groq",
          id: "llama",
          name: "Llama",
          reasoning: false,
          input: ["text"],
          contextWindow: 131_072,
        }),
      ]),
    });

    const { models } = await buildModelRuntime("user-1");

    expect(models).toEqual([
      {
        provider: "anthropic",
        id: "claude-sonnet",
        name: "Claude Sonnet",
        reasoning: true,
        contextWindow: 200_000,
        vision: true,
      },
      {
        provider: "groq",
        id: "llama",
        name: "Llama",
        reasoning: false,
        contextWindow: 131_072,
        vision: false,
      },
    ]);
  });

  it("filters models with the admin's global configuration", async () => {
    vi.mocked(db.prisma.adminSettings.findUnique).mockResolvedValue({
      globalProviderModels: {
        groq: { enabled: false },
        openai: { enabled: true, models: ["gpt-5"] },
      },
    } as never);
    stubRuntime({
      getAvailableSnapshot: vi
        .fn()
        .mockReturnValue([
          catalogModel({ provider: "groq", id: "llama" }),
          catalogModel({ provider: "openai", id: "gpt-5" }),
          catalogModel({ provider: "openai", id: "gpt-4" }),
          catalogModel({ provider: "anthropic", id: "claude-sonnet" }),
        ]),
    });

    const { models } = await buildModelRuntime("user-1");

    // A disabled provider is gone, an allowlisted provider keeps only its list,
    // and a provider the admin never mentioned stays available.
    expect(models.map((m) => `${m.provider}:${m.id}`)).toEqual([
      "openai:gpt-5",
      "anthropic:claude-sonnet",
    ]);
  });

  it("keeps every model of a provider whose entry holds no allowlist", async () => {
    // The shape a Save used to write for providers nobody had toggled. It must
    // mean "no restriction": reading it as "everything off" hid a local
    // endpoint's models from every picker, and from the admin list that could
    // switch them back on.
    vi.mocked(db.prisma.adminSettings.findUnique).mockResolvedValue({
      globalProviderModels: {
        custom: { enabled: true, models: [] },
        groq: { enabled: true },
      },
    } as never);
    stubRuntime({
      getAvailableSnapshot: vi
        .fn()
        .mockReturnValue([
          catalogModel({ provider: "custom", id: "Qwen3-VL-8B" }),
          catalogModel({ provider: "groq", id: "llama" }),
        ]),
    });

    const { models } = await buildModelRuntime("user-1");

    expect(models.map((m) => `${m.provider}:${m.id}`)).toEqual([
      "custom:Qwen3-VL-8B",
      "groq:llama",
    ]);
  });

  it("lists models the admin switched off when building the admin's own list", async () => {
    vi.mocked(db.prisma.adminSettings.findUnique).mockResolvedValue({
      globalProviderModels: {
        groq: { enabled: false },
        openai: { enabled: true, models: ["gpt-5"] },
      },
    } as never);
    stubRuntime({
      getAvailableSnapshot: vi
        .fn()
        .mockReturnValue([
          catalogModel({ provider: "groq", id: "llama" }),
          catalogModel({ provider: "openai", id: "gpt-5" }),
          catalogModel({ provider: "openai", id: "gpt-4" }),
        ]),
    });

    // What a user can pick…
    const user = await buildModelRuntime("user-1");
    expect(user.models.map((m) => `${m.provider}:${m.id}`)).toEqual(["openai:gpt-5"]);

    // …and what the admin page must show to be able to switch them back on.
    const admin = await buildAdminModelList();
    expect(admin.models.map((m) => `${m.provider}:${m.id}`)).toEqual([
      "groq:llama",
      "openai:gpt-5",
      "openai:gpt-4",
    ]);
  });

  it("prefers the user's own endpoint over the global one", async () => {
    stubEndpointRow({ baseUrl: "http://user-host:8080/v1" });
    vi.mocked(db.prisma.providerApiKey.findFirst).mockResolvedValue({
      baseUrl: "http://global-host:8080/v1",
    } as never);
    stubModelListing(["local-model"]);
    const runtime = stubRuntime();

    await buildModelRuntime("user-1");

    expect(runtime.registerProvider).toHaveBeenCalledWith(
      "custom",
      expect.objectContaining({ baseUrl: "http://user-host:8080/v1" }),
    );
  });

  it("inherits the global endpoint for a user who has none of their own", async () => {
    // An admin's local endpoint is usable by everyone, so its models have to be
    // registered for everyone  reading only the user's own row hid them.
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.prisma.providerApiKey.findFirst).mockResolvedValue({
      baseUrl: "http://global-host:8080/v1",
      encryptedKey: "enc()",
      contextWindow: 4096,
      maxOutputTokens: 1024,
      modelCapabilities: null,
    } as never);
    stubModelListing(["local-model"]);
    const runtime = stubRuntime();

    const { models } = await buildModelRuntime("user-1");

    expect(runtime.registerProvider).toHaveBeenCalledWith(
      "custom",
      expect.objectContaining({
        baseUrl: "http://global-host:8080/v1",
        models: [
          expect.objectContaining({ id: "local-model", contextWindow: 4096, maxTokens: 1024 }),
        ],
      }),
    );
    // …and the models reach the list the pickers render, not just the runtime.
    expect(models.map((m) => `${m.provider}:${m.id}`)).toEqual(["custom:local-model"]);
  });

  it("reads the global endpoint for the global runtime", async () => {
    await buildGlobalModelRuntime();

    expect(db.prisma.providerApiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: null, provider: "custom" } }),
    );
  });

  describe("Saale's OpenAI-compatible endpoint", () => {
    it("registers the endpoint's models, with the user's limits", async () => {
      stubEndpointRow({ contextWindow: 32_768, maxOutputTokens: 8_192 });
      vi.mocked(crypto.decrypt).mockReturnValue("local-key");
      stubModelListing(["local-model"]);
      const runtime = stubRuntime();

      await buildModelRuntime("user-1");

      // The key goes to the runtime, since Pi has no auth flow for an endpoint
      // it does not know.
      expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("custom", "local-key");
      expect(runtime.registerProvider).toHaveBeenCalledWith(
        "custom",
        expect.objectContaining({
          baseUrl: "http://localhost:8080/v1",
          models: [
            expect.objectContaining({
              id: "local-model",
              contextWindow: 32_768,
              maxTokens: 8_192,
              reasoning: false,
            }),
          ],
        }),
      );
    });

    it("keeps an unknown model conservative and a catalog hit verbatim", async () => {
      stubEndpointRow({});
      stubModelListing(["local-model", "claude-sonnet"]);
      const runtime = stubRuntime({
        getModel: vi.fn((provider: string, id: string) =>
          id === "claude-sonnet"
            ? catalogModel({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } })
            : undefined,
        ),
      });

      await buildModelRuntime("user-1");

      const definition = vi.mocked(runtime.registerProvider).mock.calls[0]![1] as {
        models: Record<string, unknown>[];
      };
      const unknown = definition.models.find((m) => m.id === "local-model")!;
      // Pi knows nothing about it: claim nothing, and use Pi's default limits.
      expect(unknown).toMatchObject({
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      });

      const known = definition.models.find((m) => m.id === "claude-sonnet")!;
      expect(known).toMatchObject({
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15 },
        contextWindow: 200_000,
      });
    });

    it("applies a per-model limit over the endpoint default and the catalog", async () => {
      // One server, two windows: the endpoint default is 128k, and the model
      // Pi's catalog over-reports at 200k is the one the endpoint serves at 32k.
      stubEndpointRow({
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        modelCapabilities: { "claude-sonnet": { contextWindow: 32_768 } },
      });
      stubModelListing(["local-model", "claude-sonnet"]);
      const runtime = stubRuntime({
        getModel: vi.fn((provider: string, id: string) =>
          id === "claude-sonnet" ? catalogModel() : undefined,
        ),
      });

      await buildModelRuntime("user-1");

      const definition = vi.mocked(runtime.registerProvider).mock.calls[0]![1] as {
        models: Record<string, unknown>[];
      };
      expect(definition.models.find((m) => m.id === "claude-sonnet")).toMatchObject({
        contextWindow: 32_768,
        maxTokens: 8_192,
      });
      // The model without an override keeps the endpoint's default.
      expect(definition.models.find((m) => m.id === "local-model")).toMatchObject({
        contextWindow: 131_072,
        maxTokens: 8_192,
      });
    });

    it("uses the window and vision the endpoint's own listing states", async () => {
      // What llama-swap serves on /v1/models  verified against a live instance.
      stubEndpointRow({});
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: "qwen3.8-27b",
                owned_by: "llama-swap",
                capabilities: { vision: true },
                context_length: 131_072,
                meta: { n_ctx: 131_072, llamaswap: { type: "model" } },
              },
            ],
          }),
        }),
      );
      const runtime = stubRuntime();

      await buildModelRuntime("user-1");

      const definition = vi.mocked(runtime.registerProvider).mock.calls[0]![1] as {
        models: Record<string, unknown>[];
      };
      expect(definition.models[0]).toMatchObject({
        id: "qwen3.8-27b",
        contextWindow: 131_072,
        // Nobody configured an output cap, so Pi's default applies.
        maxTokens: 16_384,
        input: ["text", "image"],
      });
    });

    it("lets a recorded vision capability overrule the catalog", async () => {
      stubEndpointRow({ modelCapabilities: { "local-model": { vision: true } } });
      stubModelListing(["local-model"]);
      const runtime = stubRuntime();

      await buildModelRuntime("user-1");

      const definition = vi.mocked(runtime.registerProvider).mock.calls[0]![1] as {
        models: Record<string, unknown>[];
      };
      expect(definition.models[0]).toMatchObject({ input: ["text", "image"] });
    });

    it("registers the endpoint even when its listing fails", async () => {
      stubEndpointRow({});
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const runtime = stubRuntime();

      await buildModelRuntime("user-1");

      // No models, but the endpoint itself is registered, so a later import can
      // fill it in.
      expect(runtime.registerProvider).toHaveBeenCalledWith(
        "custom",
        expect.objectContaining({ baseUrl: "http://localhost:8080/v1" }),
      );
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    });

    it("keeps the endpoint usable when its key cannot be decrypted", async () => {
      stubEndpointRow({});
      vi.mocked(crypto.decrypt).mockImplementation(() => {
        throw new Error("bad key");
      });
      stubModelListing(["local-model"]);
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const runtime = stubRuntime();

      const { models } = await buildModelRuntime("user-1");

      // A local server needs no key  dropping the whole endpoint over one bad
      // ciphertext would take its models away.
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Failed to decrypt"),
        expect.anything(),
      );
      expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
      expect(runtime.registerProvider).toHaveBeenCalled();
      expect(models).toBeDefined();
      log.mockRestore();
    });

    it("does nothing when no endpoint is configured", async () => {
      const runtime = stubRuntime();

      await buildModelRuntime("user-1");

      expect(runtime.registerProvider).not.toHaveBeenCalled();
      expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    });
  });
});
