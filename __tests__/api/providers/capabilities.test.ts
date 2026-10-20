import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    providerApiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn().mockReturnValue(""),
}));

import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as crypto from "@/lib/crypto";
import { PATCH, POST } from "@/app/api/providers/capabilities/route";

const authed = () =>
  vi.mocked(auth.requireSession).mockResolvedValue({
    ok: true,
    user: { id: "user-1" },
  } as never);

const patch = (body: unknown) =>
  new NextRequest("http://localhost/api/providers/capabilities", {
    method: "PATCH",
    body: JSON.stringify(body),
  });

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/providers/capabilities", {
    method: "POST",
    body: JSON.stringify(body),
  });

/** A stored provider key row, with the fields the route reads. */
function storedKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    provider: "custom",
    baseUrl: "http://localhost:8080/v1",
    encryptedKey: "enc()",
    modelCapabilities: null,
    ...overrides,
  };
}

describe("PATCH /api/providers/capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    authed();
    vi.mocked(crypto.decrypt).mockReturnValue("");
  });

  it("stores a vision flag on the authenticated user's provider", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(
      storedKey({ modelCapabilities: { "text-model": { vision: false } } }) as never,
    );
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(
      storedKey({ modelCapabilities: { "text-model": { vision: false } } }) as never,
    );

    const response = await PATCH(patch({ provider: "custom", modelId: "vl", vision: true }));

    expect(response.status).toBe(200);
    expect(db.prisma.providerApiKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_provider: { userId: "user-1", provider: "custom" } },
      }),
    );
    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { modelCapabilities: { "text-model": { vision: false }, vl: { vision: true } } },
    });
    await expect(response.json()).resolves.toMatchObject({
      modelCapabilities: { vl: { vision: true } },
    });
  });

  it("removes the entry when the model goes back to automatic detection", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(
      storedKey({ modelCapabilities: { vl: { vision: true } } }) as never,
    );
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(storedKey() as never);

    await PATCH(patch({ provider: "custom", modelId: "vl", vision: null }));

    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { modelCapabilities: {} },
    });
  });

  it("records per-model limits without touching the vision flag", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(
      storedKey({ modelCapabilities: { big: { vision: true } } }) as never,
    );
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(storedKey() as never);

    const response = await PATCH(
      patch({
        provider: "custom",
        modelId: "big",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
      }),
    );

    expect(response.status).toBe(200);
    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: {
        modelCapabilities: {
          big: { vision: true, contextWindow: 32_768, maxOutputTokens: 4_096 },
        },
      },
    });
  });

  it("clears one limit and leaves the other as stored", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(
      storedKey({
        modelCapabilities: { big: { contextWindow: 32_768, maxOutputTokens: 4_096 } },
      }) as never,
    );
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(storedKey() as never);

    await PATCH(patch({ provider: "custom", modelId: "big", contextWindow: null }));

    const update = vi.mocked(db.prisma.providerApiKey.update).mock.calls[0]![0];
    expect(update.data).toEqual({
      modelCapabilities: { big: { maxOutputTokens: 4_096 } },
    });
  });

  it("rejects an edit that changes nothing and an inverted pair", async () => {
    const empty = await PATCH(patch({ provider: "custom", modelId: "big" }));
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({
      error: expect.stringContaining("contextWindow"),
    });

    const inverted = await PATCH(
      patch({ provider: "custom", modelId: "big", contextWindow: 4_096, maxOutputTokens: 8_192 }),
    );
    expect(inverted.status).toBe(400);
    await expect(inverted.json()).resolves.toMatchObject({
      error: "maxOutputTokens cannot exceed contextWindow",
    });
    expect(db.prisma.providerApiKey.update).not.toHaveBeenCalled();
  });

  it("rejects a provider whose models come from Pi's catalog", async () => {
    const response = await PATCH(patch({ provider: "anthropic", modelId: "claude", vision: true }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("OpenAI-compatible"),
    });
    expect(db.prisma.providerApiKey.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a model id the request omits", async () => {
    const response = await PATCH(patch({ provider: "custom", vision: true }));

    expect(response.status).toBe(400);
    expect(db.prisma.providerApiKey.findUnique).not.toHaveBeenCalled();
  });

  it("404s for a provider the user has not configured", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(null);

    const response = await PATCH(patch({ provider: "custom", modelId: "vl", vision: true }));

    expect(response.status).toBe(404);
    expect(db.prisma.providerApiKey.update).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await PATCH(patch({ provider: "custom", modelId: "vl", vision: true }));

    expect(response.status).toBe(401);
    expect(db.prisma.providerApiKey.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/providers/capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    authed();
    vi.mocked(crypto.decrypt).mockReturnValue("");
  });

  /** The provider's `/models` listing plus llama.cpp's `/props` answers. */
  function stubLlamaCpp(visionModels: string[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const requested = String(url);
        if (requested.endsWith("/models")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "Qwen3-VL-8B" }, { id: "Llama-3-8B" }] }),
          };
        }
        const model = new URL(requested).searchParams.get("model");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model_path: `/models/${model}/quant.gguf`,
            modalities: { vision: visionModels.includes(model ?? "") },
          }),
        };
      }),
    );
  }

  it("probes the endpoint and stores what it reports", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(storedKey() as never);
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(storedKey() as never);
    stubLlamaCpp(["Qwen3-VL-8B"]);

    const response = await POST(post({ provider: "custom" }));

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
    await expect(response.json()).resolves.toMatchObject({
      modelCount: 2,
      detected: 2,
      visionModels: 1,
      unprobed: 0,
    });
  });

  it("keeps a stored answer the endpoint cannot replace", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(
      storedKey({ modelCapabilities: { "hand-set": { vision: true } } }) as never,
    );
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(storedKey() as never);
    stubLlamaCpp(["Qwen3-VL-8B"]);

    await POST(post({ provider: "custom" }));

    const update = vi.mocked(db.prisma.providerApiKey.update).mock.calls[0]![0];
    expect(update.data).toMatchObject({
      modelCapabilities: {
        "hand-set": { vision: true },
        "Qwen3-VL-8B": { vision: true },
        "Llama-3-8B": { vision: false },
      },
    });
  });

  it("reports an endpoint that answers nothing instead of claiming no vision", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(storedKey() as never);
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(storedKey() as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/models")
          ? { ok: true, status: 200, json: async () => ({ data: [{ id: "only-model" }] }) }
          : { ok: false, status: 404, json: async () => ({}) },
      ),
    );

    const response = await POST(post({ provider: "custom" }));

    // Nothing was answered, so nothing is written  the stored map already says
    // exactly as much as the endpoint did.
    expect(db.prisma.providerApiKey.update).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      detected: 0,
      visionModels: 0,
      unprobed: 1,
    });
  });

  it("probes the stored base URL, not one from the request", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(
      storedKey({ baseUrl: "http://127.0.0.1:9999/v1" }) as never,
    );
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(storedKey() as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    );

    await POST(post({ provider: "custom", baseUrl: "http://evil.example.com/v1" }));

    const requested = vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]));
    expect(requested[0]).toContain("127.0.0.1:9999");
    expect(requested.join(" ")).not.toContain("evil.example.com");
  });

  it("rejects a provider with no base URL to probe", async () => {
    vi.mocked(db.prisma.providerApiKey.findUnique).mockResolvedValue(
      storedKey({ baseUrl: null }) as never,
    );

    const response = await POST(post({ provider: "custom" }));

    expect(response.status).toBe(400);
    expect(db.prisma.providerApiKey.update).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await POST(post({ provider: "custom" }));

    expect(response.status).toBe(401);
  });
});
