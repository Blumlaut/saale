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
      update: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((v: string) => `enc(${v})`),
}));

import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import { POST, PATCH } from "@/app/api/providers/route";

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
  beforeEach(() => {
    vi.clearAllMocks();
    authed();
    // Discovery against a local endpoint — no models returned.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })),
    );
    vi.mocked(db.prisma.providerApiKey.upsert).mockResolvedValue({
      id: "key-1",
      userId: "user-1",
      provider: "custom",
      encryptedKey: "enc()",
      label: "",
      baseUrl: "http://localhost:8080/v1",
      contextWindow: null,
      maxOutputTokens: null,
      modelCapabilities: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("stores model limits for an OpenAI-compatible provider", async () => {
    const response = await POST(
      post({
        provider: "custom",
        baseUrl: "http://localhost:8080/v1",
        contextWindow: 32768,
        maxOutputTokens: 8192,
      }),
    );

    expect(response.status).toBe(200);
    expect(db.prisma.providerApiKey.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ contextWindow: 32768, maxOutputTokens: 8192 }),
        update: expect.objectContaining({ contextWindow: 32768, maxOutputTokens: 8192 }),
      }),
    );
  });

  it("stores null for a limit the user left empty", async () => {
    await POST(
      post({ provider: "custom", baseUrl: "http://localhost:8080/v1", contextWindow: 32768 }),
    );

    expect(db.prisma.providerApiKey.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ contextWindow: 32768, maxOutputTokens: null }),
      }),
    );
  });

  it("rejects model limits for a catalog-backed provider", async () => {
    const response = await POST(
      post({ provider: "anthropic", apiKey: "sk-ant-123", maxOutputTokens: 4096 }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("OpenAI-compatible"),
    });
    expect(db.prisma.providerApiKey.upsert).not.toHaveBeenCalled();
  });

  it("rejects an invalid limit instead of silently clamping it", async () => {
    for (const invalid of [-1, 0, "abc"]) {
      const response = await POST(
        post({ provider: "custom", baseUrl: "http://localhost:8080/v1", maxOutputTokens: invalid }),
      );

      expect(response.status).toBe(400);
    }
    expect(db.prisma.providerApiKey.upsert).not.toHaveBeenCalled();
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

    const response = await POST(post({ provider: "custom", baseUrl: "http://localhost:8080/v1" }));

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
    vi.mocked(db.prisma.providerApiKey.upsert).mockResolvedValue({
      id: "key-1",
      userId: "user-1",
      provider: "custom",
      encryptedKey: "enc()",
      label: "",
      baseUrl: "http://localhost:8080/v1",
      contextWindow: null,
      maxOutputTokens: null,
      modelCapabilities: { "hand-set": { vision: true } },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue({} as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/models")
          ? { ok: true, status: 200, json: async () => ({ data: [{ id: "hand-set" }] }) }
          : { ok: false, status: 404, json: async () => ({}) },
      ),
    );

    await POST(post({ provider: "custom", baseUrl: "http://localhost:8080/v1" }));

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
