import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    adminSettings: { findUnique: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { resolveModelForPurpose, splitModelReference } from "@/lib/pi/model-resolution";

/**
 * Model references reach us in two shapes — Saale's `provider:modelId` (jobs,
 * Telegram) and Pi's canonical `provider/modelId` — over model ids that
 * themselves contain both characters. Getting the provider boundary wrong
 * silently resolves to a model the runtime does not have.
 */
describe("splitModelReference", () => {
  it("splits on the first separator, leaving the model id intact", () => {
    expect(splitModelReference("openrouter:anthropic/claude-sonnet-4")).toEqual({
      provider: "openrouter",
      name: "anthropic/claude-sonnet-4",
    });
    expect(splitModelReference("openrouter/anthropic/claude-sonnet-4")).toEqual({
      provider: "openrouter",
      name: "anthropic/claude-sonnet-4",
    });
    expect(splitModelReference("openai:gpt-5:exacto")).toEqual({
      provider: "openai",
      name: "gpt-5:exacto",
    });
    expect(splitModelReference("  custom:my-model  ")).toEqual({
      provider: "custom",
      name: "my-model",
    });
  });

  it("rejects a reference with no provider prefix", () => {
    expect(splitModelReference("claude-sonnet-4")).toBeUndefined();
    expect(splitModelReference(":model")).toBeUndefined();
    expect(splitModelReference("openrouter:")).toBeUndefined();
    expect(splitModelReference("")).toBeUndefined();
    expect(splitModelReference(null)).toBeUndefined();
  });
});

describe("resolveModelForPurpose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.adminSettings.findUnique).mockResolvedValue(null);
  });

  it("resolves an explicit reference without touching the app settings", async () => {
    await expect(
      resolveModelForPurpose("user-1", "chat", "openrouter:anthropic/claude-sonnet-4"),
    ).resolves.toEqual({ provider: "openrouter", name: "anthropic/claude-sonnet-4" });
    expect(prisma.appSettings.findUnique).not.toHaveBeenCalled();
  });

  it("keeps a slash in the model id of a purpose override", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      defaultModelProvider: null,
      defaultModelName: null,
      purposeModelOverrides: {
        email_draft: { provider: "together", model: "meta-llama/Llama-3-70b" },
      },
    } as never);

    await expect(resolveModelForPurpose("user-1", "email_draft")).resolves.toEqual({
      provider: "together",
      name: "meta-llama/Llama-3-70b",
    });
  });

  it("falls back to the admin default when the user has no settings", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.adminSettings.findUnique).mockResolvedValue({
      globalModelProvider: "anthropic",
      globalModelName: "claude-opus-4",
    } as never);

    await expect(resolveModelForPurpose("user-1", "chat")).resolves.toEqual({
      provider: "anthropic",
      name: "claude-opus-4",
    });
  });

  it("returns undefined when nothing is configured anywhere", async () => {
    await expect(resolveModelForPurpose("user-1", "chat")).resolves.toBeUndefined();

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      defaultModelProvider: "anthropic",
      defaultModelName: "claude-sonnet-4",
      purposeModelOverrides: null,
    } as never);
    await expect(resolveModelForPurpose("user-1", "chat")).resolves.toEqual({
      provider: "anthropic",
      name: "claude-sonnet-4",
    });
  });
});
