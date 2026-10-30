import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    providerApiKey: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((v: string) => `enc(${v})`),
}));

// The endpoint import (`fetchOpenAIModels`) stays real so the POST tests can
// stub the HTTP listing; only the runtime build is replaced.
vi.mock("@/lib/pi/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pi/models")>()),
  buildModelRuntime: vi.fn(),
}));

import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as piModels from "@/lib/pi/models";
import { DELETE, GET, POST, PATCH } from "@/app/api/providers/route";

const authed = () =>
  vi.mocked(auth.requireSession).mockResolvedValue({
    ok: true,
    user: { id: "user-1" },
  } as never);

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/providers", {
    method: "POST",
    body: JSON.stringify(body),
  });

const patch = (body: unknown) =>
  new NextRequest("http://localhost/api/providers", {
    method: "PATCH",
    body: JSON.stringify(body),
  });

describe("POST /api/providers", () => {
  /** A stored endpoint row, as a write hands one back. */
  const endpointRow = (provider: string, overrides: Record<string, unknown> = {}) => ({
    id: "key-1",
    userId: "user-1",
    provider,
    encryptedKey: "enc()",
    label: "",
    baseUrl: "http://localhost:8080/v1",
    encryptedCredential: null,
    contextWindow: null,
    maxOutputTokens: null,
    modelCapabilities: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authed();
    // Discovery against a local endpoint  no models returned.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })),
    );
    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([] as never);
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.prisma.providerApiKey.create).mockResolvedValue(
      endpointRow("custom-endpoint") as never,
    );
  });

  it("adds an endpoint under a provider id taken from its name", async () => {
    const response = await POST(
      post({
        label: "llama.cpp",
        baseUrl: "http://localhost:8080/v1",
        contextWindow: 32768,
        maxOutputTokens: 8192,
      }),
    );

    expect(response.status).toBe(200);
    expect(db.prisma.providerApiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        provider: "custom-llama-cpp",
        contextWindow: 32768,
        maxOutputTokens: 8192,
      }),
    });
  });

  it("gives a second endpoint of the same name its own id", async () => {
    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([
      { provider: "custom-llama-cpp" },
    ] as never);

    await POST(post({ label: "llama.cpp", baseUrl: "http://localhost:9090/v1" }));

    expect(db.prisma.providerApiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ provider: "custom-llama-cpp-2" }),
    });
  });

  it("updates the endpoint the body names, leaving the scope's others alone", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue({ id: "key-2" } as never);
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(
      endpointRow("custom-openrouter") as never,
    );

    const response = await POST(
      post({ provider: "custom-openrouter", baseUrl: "http://localhost:1234/v1" }),
    );

    expect(response.status).toBe(200);
    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "key-2" },
      data: expect.objectContaining({ baseUrl: "http://localhost:1234/v1" }),
    });
    expect(db.prisma.providerApiKey.create).not.toHaveBeenCalled();
  });

  it("answers 404 for an endpoint the scope does not have", async () => {
    const response = await POST(post({ provider: "custom-vllm", baseUrl: "http://x.test/v1" }));

    expect(response.status).toBe(404);
    expect(db.prisma.providerApiKey.create).not.toHaveBeenCalled();
  });

  it("stores null for a limit the user left empty", async () => {
    await POST(post({ baseUrl: "http://localhost:8080/v1", contextWindow: 32768 }));

    expect(db.prisma.providerApiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contextWindow: 32768, maxOutputTokens: null }),
    });
  });

  it("rejects model limits for a catalog-backed provider", async () => {
    const response = await POST(
      post({ provider: "anthropic", apiKey: "sk-ant-123", maxOutputTokens: 4096 }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("OpenAI-compatible"),
    });
    expect(db.prisma.providerApiKey.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid limit instead of silently clamping it", async () => {
    for (const invalid of [-1, 0, "abc"]) {
      const response = await POST(
        post({ baseUrl: "http://localhost:8080/v1", maxOutputTokens: invalid }),
      );

      expect(response.status).toBe(400);
    }
    expect(db.prisma.providerApiKey.create).not.toHaveBeenCalled();
  });

  it("records which of the endpoint's models can see images", async () => {
    // An import is where Saale can learn this: llama.cpp answers `/props` with
    // the projector it loaded, and without it Pi strips every image from the
    // request to that model.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/models")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "Qwen3-VL-8B" }, { id: "Llama-3-8B" }] }),
          };
        }
        const model = new URL(String(url)).searchParams.get("model");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model_path: `/models/${model}/quant.gguf`,
            modalities: { vision: model === "Qwen3-VL-8B" },
          }),
        };
      }),
    );
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue({} as never);

    const response = await POST(post({ baseUrl: "http://localhost:8080/v1" }));

    expect(response.status).toBe(200);
    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: {
        modelCapabilities: {
          "Qwen3-VL-8B": { vision: true },
          "Llama-3-8B": { vision: false },
        },
      },
    });
    await expect(response.json()).resolves.toMatchObject({ modelCount: 2, visionModels: 1 });
  });

  it("keeps capabilities the user set when the endpoint cannot answer", async () => {
    vi.mocked(db.prisma.providerApiKey.create).mockResolvedValue(
      endpointRow("custom-endpoint", {
        modelCapabilities: { "hand-set": { vision: true } },
      }) as never,
    );
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue({} as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/models")
          ? { ok: true, status: 200, json: async () => ({ data: [{ id: "hand-set" }] }) }
          : { ok: false, status: 404, json: async () => ({}) },
      ),
    );

    await POST(post({ baseUrl: "http://localhost:8080/v1" }));

    // `/props` answered nothing, so the stored override stands and no write is
    // needed to say so.
    expect(db.prisma.providerApiKey.update).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authed();
  });

  it("updates limits without touching the stored API key", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue({ id: "key-1" } as never);
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue({
      id: "key-1",
      userId: "user-1",
      provider: "custom",
      encryptedKey: "unchanged",
      encryptedCredential: null,
      label: "",
      baseUrl: "http://localhost:8080/v1",
      contextWindow: 16384,
      maxOutputTokens: 4096,
      modelCapabilities: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await PATCH(
      patch({ provider: "custom", contextWindow: 16384, maxOutputTokens: 4096 }),
    );

    expect(response.status).toBe(200);
    const updateArg = vi.mocked(db.prisma.providerApiKey.update).mock.calls[0]?.[0];
    expect(updateArg?.data).toEqual({ contextWindow: 16384, maxOutputTokens: 4096 });
    expect(updateArg?.data).not.toHaveProperty("encryptedKey");
    await expect(response.json()).resolves.toMatchObject({
      contextWindow: 16384,
      maxOutputTokens: 4096,
    });
  });

  it("looks the provider up scoped to the authenticated user", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(null);

    const response = await PATCH(patch({ provider: "custom", maxOutputTokens: 4096 }));

    expect(response.status).toBe(404);
    expect(db.prisma.providerApiKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_provider: { userId: "user-1", provider: "custom" } },
      }),
    );
    expect(db.prisma.providerApiKey.update).not.toHaveBeenCalled();
  });

  it("clears limits when both fields are emptied", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue({ id: "key-1" } as never);
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue({
      id: "key-1",
      userId: "user-1",
      provider: "custom",
      encryptedKey: "unchanged",
      encryptedCredential: null,
      label: "",
      baseUrl: null,
      contextWindow: null,
      maxOutputTokens: null,
      modelCapabilities: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await PATCH(patch({ provider: "custom" }));

    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { contextWindow: null, maxOutputTokens: null },
    });
  });

  it("requires a provider", async () => {
    const response = await PATCH(patch({ maxOutputTokens: 4096 }));

    expect(response.status).toBe(400);
    expect(db.prisma.providerApiKey.findUnique).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await PATCH(patch({ provider: "custom", maxOutputTokens: 4096 }));

    expect(response.status).toBe(401);
    expect(db.prisma.providerApiKey.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/providers", () => {
  /** A Pi provider, as the runtime's catalog describes one. */
  const piProvider = {
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    baseUrl: undefined,
    auth: {
      apiKey: { name: "Cloudflare API key" },
      oauth: undefined,
    },
    getModels: () => new Array(54).fill({ id: "model" }),
  };

  const groqProvider = {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: { apiKey: { name: "Groq API key" }, oauth: undefined },
    getModels: () => new Array(7).fill({ id: "model" }),
  };

  /** Registered by `registerProvider` once the user configures the endpoint. */
  const customProvider = {
    id: "custom",
    name: "custom",
    baseUrl: "http://localhost:8080/v1",
    auth: { apiKey: { name: "api key" }, oauth: undefined },
    getModels: () => [{ id: "local-model" }],
  };

  function stubRuntime(status: Record<string, { configured: boolean; source?: string }>) {
    vi.mocked(piModels.buildModelRuntime).mockResolvedValue({
      models: [],
      modelRuntime: {
        getProviders: () => [piProvider, groqProvider, customProvider],
        getModels: (id?: string) => (id === "custom" ? [{ id: "local-model" }] : []),
        getProviderAuthStatus: (id: string) => status[id] ?? { configured: false },
      },
    } as never);
  }

  const row = (overrides: Record<string, unknown>) => ({
    id: "row-1",
    provider: "custom",
    label: "",
    baseUrl: "http://localhost:8080/v1",
    contextWindow: null,
    maxOutputTokens: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authed();
    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([] as never);
    stubRuntime({});
  });

  it("lists every provider Pi can talk to, with how it authenticates", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    const cloudflare = body.availableProviders.find(
      (entry: { id: string }) => entry.id === "cloudflare-ai-gateway",
    );

    // Pi's name, Pi's model count, Pi's auth method  nothing hand-maintained.
    expect(cloudflare).toMatchObject({
      name: "Cloudflare AI Gateway",
      modelCount: 54,
      custom: false,
      modelsConfigurable: false,
      configured: false,
      methods: [{ type: "api_key", label: "Cloudflare API key", subscription: false }],
    });
  });

  it("lists every endpoint the scope has, each under its own name", async () => {
    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([
      row({ provider: "custom-llama-cpp", label: "llama.cpp" }),
      row({ provider: "custom-openrouter", label: "OpenRouter" }),
    ] as never);

    const body = await (await GET()).json();
    const endpoints = body.availableProviders.filter((entry: { custom: boolean }) => entry.custom);

    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]).toMatchObject({
      id: "custom-llama-cpp",
      name: "llama.cpp",
      custom: true,
      configured: true,
      modelsConfigurable: true,
    });
    expect(endpoints[1]).toMatchObject({ id: "custom-openrouter", name: "OpenRouter" });
    // Pi's own catalog is the only source of Pi's providers, so no provider
    // appears twice and the endpoints are not read from the runtime.
    const ids = body.availableProviders.map((entry: { id: string }) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks the endpoint configured from its row, not from Pi's auth state", async () => {
    // A keyless local server is configured without any credential Pi could see.
    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([row({})] as never);

    const body = await (await GET()).json();
    const custom = body.availableProviders.find((entry: { id: string }) => entry.id === "custom");

    expect(custom).toMatchObject({ configured: true, source: "stored" });
  });

  it("reports a provider configured through Pi's credential store", async () => {
    stubRuntime({ "cloudflare-ai-gateway": { configured: true, source: "stored" } });

    const body = await (await GET()).json();
    const cloudflare = body.availableProviders.find(
      (entry: { id: string }) => entry.id === "cloudflare-ai-gateway",
    );

    expect(cloudflare).toMatchObject({ configured: true, source: "stored", isGlobal: false });
  });

  it("separates the user's credentials from the global ones they inherit", async () => {
    vi.mocked(db.prisma.providerApiKey.findMany).mockImplementation((async (args: {
      where: { userId: string | null };
    }) =>
      args.where.userId === null
        ? [row({ id: "global-1", provider: "groq", label: "global groq" })]
        : [row({ id: "user-1", provider: "custom" })]) as never);
    stubRuntime({ groq: { configured: true, source: "stored" } });

    const body = await (await GET()).json();

    // The inherited provider is not in the caller's own rows…
    expect(body.providers.map((entry: { provider: string }) => entry.provider)).toEqual(["custom"]);
    // …but it is usable, and marked as an admin's.
    const groq = body.availableProviders.find((entry: { id: string }) => entry.id === "groq");
    expect(groq).toMatchObject({ configured: true, isGlobal: true });
  });

  it("requires authentication", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(piModels.buildModelRuntime).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authed();
  });

  it("removes the credential scoped to the authenticated user", async () => {
    vi.mocked(db.prisma.providerApiKey.deleteMany).mockResolvedValue({ count: 1 } as never);

    const response = await DELETE(
      new NextRequest("http://localhost/api/providers?provider=anthropic", { method: "DELETE" }),
    );

    expect(response.status).toBe(200);
    expect(db.prisma.providerApiKey.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "anthropic" },
    });
  });

  it("requires a provider", async () => {
    const response = await DELETE(
      new NextRequest("http://localhost/api/providers", { method: "DELETE" }),
    );

    expect(response.status).toBe(400);
    expect(db.prisma.providerApiKey.deleteMany).not.toHaveBeenCalled();
  });
});
