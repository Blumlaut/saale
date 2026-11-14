import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    adminSettings: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/pi/models", () => ({ buildModelRuntime: vi.fn() }));

import { prisma } from "@/lib/db";
import * as models from "@/lib/pi/models";
import { resolveImageCapabilities, resolveImageModel } from "@/lib/pi/image-model";

/** One image model, as Pi's image list hands it back. */
function imageModel(overrides: Record<string, unknown> = {}) {
  return {
    type: "image",
    provider: "custom",
    id: "qwen-image-2.1-turbo",
    name: "qwen-image-2.1-turbo",
    input: ["text", "image"],
    ...overrides,
  };
}

/** The runtime a user scope builds, with the models it can see. */
function stubRuntime(available: unknown[]) {
  const runtime = { getModelOfType: vi.fn().mockReturnValue(available[0]) };
  vi.mocked(models.buildModelRuntime).mockResolvedValue({
    modelRuntime: runtime,
    models: [],
  } as never);
  return runtime;
}

describe("resolveImageModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.adminSettings.findUnique).mockResolvedValue(null);
  });

  // The account that never opened Settings → Models has to inherit whatever the
  // instance chose, otherwise an image tool exists for the admin and nobody else.
  it("follows the instance's model for an account that picked none", async () => {
    vi.mocked(prisma.adminSettings.findUnique).mockResolvedValue({
      imageModel: "custom:qwen-image-2.1-turbo",
    } as never);

    expect(await resolveImageModel("user-1")).toEqual({
      provider: "custom",
      id: "qwen-image-2.1-turbo",
    });
  });

  it("prefers the account's own pick over the instance's", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      imageModel: "custom-venice:flux",
    } as never);
    vi.mocked(prisma.adminSettings.findUnique).mockResolvedValue({
      imageModel: "custom:qwen-image-2.1-turbo",
    } as never);

    expect(await resolveImageModel("user-1")).toEqual({ provider: "custom-venice", id: "flux" });
  });

  it("has no model when neither side picked one", async () => {
    expect(await resolveImageModel("user-1")).toBeNull();
  });
});

describe("resolveImageCapabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      imageModel: "custom:qwen-image-2.1-turbo",
    } as never);
  });

  it("offers editing to a model that takes a picture", async () => {
    stubRuntime([imageModel()]);

    expect(await resolveImageCapabilities("user-1")).toEqual({ generate: true, edit: true });
  });

  it("offers only generation to a model that renders from a prompt alone", async () => {
    stubRuntime([imageModel({ input: ["text"] })]);

    expect(await resolveImageCapabilities("user-1")).toEqual({ generate: true, edit: false });
  });

  // A pick whose model the account's providers no longer serve (a deleted
  // endpoint, a renamed model) leaves the tool out rather than failing the build.
  it("reports nothing for a pick Pi has no such model for", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubRuntime([undefined]);

    expect(await resolveImageCapabilities("user-1")).toEqual({ generate: false, edit: false });
  });

  it("keeps an image model out of reach that Pi reports as another type", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubRuntime([imageModel({ type: "chat" })]);

    expect(await resolveImageCapabilities("user-1")).toEqual({ generate: false, edit: false });
  });
});
