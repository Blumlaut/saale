import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    providerApiKey: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

import * as db from "@/lib/db";
import * as crypto from "@/lib/crypto";
import { requirePermission } from "@/lib/auth";
import { PATCH, POST } from "@/app/api/admin/providers/capabilities/route";

const asAdmin = () =>
  vi.mocked(requirePermission).mockResolvedValue({
    ok: true,
    user: { id: "admin-1" },
  } as never);

const patch = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/providers/capabilities", {
    method: "PATCH",
    body: JSON.stringify(body),
  });

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/providers/capabilities", {
    method: "POST",
    body: JSON.stringify(body),
  });

function globalKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    provider: "custom",
    baseUrl: "http://localhost:8080/v1",
    encryptedKey: "enc()",
    modelCapabilities: null,
    ...overrides,
  };
}

describe("PATCH /api/admin/providers/capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    asAdmin();
    vi.mocked(crypto.decrypt).mockReturnValue("");
  });

  it("stores a vision flag on the global provider", async () => {
    vi.mocked(db.prisma.providerApiKey.findFirst).mockResolvedValue(globalKey() as never);
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(globalKey() as never);

    const response = await PATCH(patch({ provider: "custom", modelId: "vl", vision: true }));

    expect(response.status).toBe(200);
    // Global providers are the rows with no owner.
    expect(db.prisma.providerApiKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: null, provider: "custom" } }),
    );
    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { modelCapabilities: { vl: { vision: true } } },
    });
  });

  it("resets a model to automatic detection", async () => {
    vi.mocked(db.prisma.providerApiKey.findFirst).mockResolvedValue(
      globalKey({ modelCapabilities: { vl: { vision: true } } }) as never,
    );
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(globalKey() as never);

    await PATCH(patch({ provider: "custom", modelId: "vl", vision: null }));

    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { modelCapabilities: {} },
    });
  });

  it("records per-model limits on the global endpoint", async () => {
    vi.mocked(db.prisma.providerApiKey.findFirst).mockResolvedValue(
      globalKey({ modelCapabilities: { vl: { vision: true } } }) as never,
    );
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(globalKey() as never);

    const response = await PATCH(
      patch({ provider: "custom", modelId: "vl", contextWindow: 131_072 }),
    );

    expect(response.status).toBe(200);
    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { modelCapabilities: { vl: { vision: true, contextWindow: 131_072 } } },
    });
  });

  it("rejects a catalog-backed provider and a missing admin session", async () => {
    const catalog = await PATCH(patch({ provider: "anthropic", modelId: "claude", vision: true }));
    expect(catalog.status).toBe(400);

    vi.mocked(requirePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const unauthenticated = await PATCH(patch({ provider: "custom", modelId: "vl", vision: true }));
    expect(unauthenticated.status).toBe(401);

    expect(db.prisma.providerApiKey.findFirst).not.toHaveBeenCalled();
  });

  it("404s when the global provider is not configured", async () => {
    vi.mocked(db.prisma.providerApiKey.findFirst).mockResolvedValue(null);

    const response = await PATCH(patch({ provider: "custom", modelId: "vl", vision: true }));

    expect(response.status).toBe(404);
    expect(db.prisma.providerApiKey.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/providers/capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    asAdmin();
    vi.mocked(crypto.decrypt).mockReturnValue("");
  });

  it("detects and stores what the global endpoint reports", async () => {
    vi.mocked(db.prisma.providerApiKey.findFirst).mockResolvedValue(globalKey() as never);
    vi.mocked(db.prisma.providerApiKey.update).mockResolvedValue(globalKey() as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/models")) {
          return { ok: true, status: 200, json: async () => ({ data: [{ id: "Qwen3-VL-8B" }] }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model_path: "/models/Qwen3-VL-8B/quant.gguf",
            modalities: { vision: true },
          }),
        };
      }),
    );

    const response = await POST(post({ provider: "custom" }));

    expect(response.status).toBe(200);
    expect(db.prisma.providerApiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { modelCapabilities: { "Qwen3-VL-8B": { vision: true } } },
    });
    await expect(response.json()).resolves.toMatchObject({
      provider: "custom",
      modelCount: 1,
      detected: 1,
      visionModels: 1,
    });
  });

  it("requires an admin session", async () => {
    vi.mocked(requirePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await POST(post({ provider: "custom" }));

    expect(response.status).toBe(401);
    expect(db.prisma.providerApiKey.findFirst).not.toHaveBeenCalled();
  });
});
