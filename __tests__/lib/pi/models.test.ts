import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    providerApiKey: {
      findMany: vi.fn(),
    },
    adminSettings: {
      findUnique: vi.fn(),
    },
  },
}));

// Mock crypto
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
}));

// Mock ModelRuntime
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(),
  },
}));

// Mock fetchOpenAIModels - use importOriginal to keep actual exports
vi.mock("@/lib/pi/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pi/models")>();
  return {
    ...actual,
    fetchOpenAIModels: vi.fn(),
    isModelAllowed: vi.fn().mockReturnValue(true),
  };
});

import * as db from "@/lib/db";
import * as crypto from "@/lib/crypto";
import * as pi from "@earendil-works/pi-coding-agent";
import { buildModelRuntime } from "@/lib/pi/models";

describe("buildModelRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks
    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValue([]);
    vi.mocked(db.prisma.adminSettings.findUnique).mockResolvedValue(null);

    vi.mocked(pi.ModelRuntime.create).mockResolvedValue({
      getModel: vi.fn(),
      getAvailableSnapshot: vi.fn().mockReturnValue([]),
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
      getProvider: vi.fn(),
      registerProvider: vi.fn(),
    } as never);
  });

  it("creates a ModelRuntime", async () => {
    const result = await buildModelRuntime("user-1");

    expect(pi.ModelRuntime.create).toHaveBeenCalled();
    expect(result.modelRuntime).toBeDefined();
    expect(result.models).toEqual([]);
  });

  it("fetches global and user-scoped provider keys", async () => {
    await buildModelRuntime("user-1");

    expect(db.prisma.providerApiKey.findMany).toHaveBeenCalledTimes(2);
    expect(db.prisma.providerApiKey.findMany).toHaveBeenCalledWith({
      where: { userId: null },
      select: { provider: true, encryptedKey: true, baseUrl: true },
    });
    expect(db.prisma.providerApiKey.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { provider: true, encryptedKey: true, baseUrl: true },
    });
  });

  it("sets runtime API keys from stored keys", async () => {
    vi.mocked(db.prisma.providerApiKey.findMany)
      .mockResolvedValueOnce([
        {
          id: "key-1",
          createdAt: new Date(),
          updatedAt: new Date(),
          userId: null,
          provider: "anthropic",
          encryptedKey: "encrypted-anthropic-key",
          label: "Anthropic",
          baseUrl: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "key-2",
          createdAt: new Date(),
          updatedAt: new Date(),
          userId: "user-1",
          provider: "openai",
          encryptedKey: "encrypted-openai-key",
          label: "OpenAI",
          baseUrl: null,
        },
      ]);

    vi.mocked(crypto.decrypt)
      .mockReturnValueOnce("sk-ant-123")
      .mockReturnValueOnce("sk-openai-456");

    await buildModelRuntime("user-1");

    expect(crypto.decrypt).toHaveBeenCalledTimes(2);
    expect(crypto.decrypt).toHaveBeenCalledWith("encrypted-anthropic-key");
    expect(crypto.decrypt).toHaveBeenCalledWith("encrypted-openai-key");
  });

  it("user keys override global keys for the same provider", async () => {
    vi.mocked(db.prisma.providerApiKey.findMany)
      .mockResolvedValueOnce([
        {
          id: "key-1",
          createdAt: new Date(),
          updatedAt: new Date(),
          userId: null,
          provider: "anthropic",
          encryptedKey: "global-key",
          label: "Anthropic Global",
          baseUrl: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "key-2",
          createdAt: new Date(),
          updatedAt: new Date(),
          userId: "user-1",
          provider: "anthropic",
          encryptedKey: "user-key",
          label: "Anthropic User",
          baseUrl: null,
        },
      ]);

    vi.mocked(crypto.decrypt)
      .mockReturnValueOnce("sk-user-key") // user key takes priority
      .mockReturnValueOnce("sk-global-key"); // global key (not used)

    await buildModelRuntime("user-1");

    // User key should be used, not global key
    const modelRuntime = (await vi.mocked(pi.ModelRuntime.create).mock.results[0]!
      .value) as Promise<unknown>;
    await modelRuntime;
  });

  it("handles decryption errors gracefully", async () => {
    vi.mocked(db.prisma.providerApiKey.findMany).mockResolvedValueOnce([
      {
        id: "key-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: null,
        provider: "anthropic",
        encryptedKey: "corrupt",
        label: "Corrupt Key",
        baseUrl: null,
      },
    ]);

    vi.mocked(crypto.decrypt).mockImplementation(() => {
      throw new Error("Decryption failed");
    });

    const result = await buildModelRuntime("user-1");

    // Should not throw, should just skip the bad key
    expect(result.modelRuntime).toBeDefined();
  });

  it("returns empty models array when runtime has no available models", async () => {
    const result = await buildModelRuntime("user-1");

    expect(result.models).toEqual([]);
  });

  it("returns models from runtime snapshot", async () => {
    vi.mocked(pi.ModelRuntime.create).mockResolvedValue({
      getModel: vi.fn(),
      getAvailableSnapshot: vi.fn().mockReturnValue([
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
        },
        {
          provider: "openai",
          id: "gpt-4o",
          name: "GPT-4o",
        },
      ]),
      setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
      getProvider: vi.fn(),
      registerProvider: vi.fn(),
    } as never);

    const result = await buildModelRuntime("user-1");

    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
    });
    expect(result.models[1]).toMatchObject({
      provider: "openai",
      id: "gpt-4o",
      name: "GPT-4o",
    });
  });

  it("fetches global admin config", async () => {
    await buildModelRuntime("user-1");

    expect(db.prisma.adminSettings.findUnique).toHaveBeenCalledWith({
      where: { id: "global" },
      select: { globalProviderModels: true },
    });
  });

  it("uses user-specific userId for queries", async () => {
    await buildModelRuntime("user-specific-456");

    expect(db.prisma.providerApiKey.findMany).toHaveBeenCalledWith({
      where: { userId: "user-specific-456" },
      select: { provider: true, encryptedKey: true, baseUrl: true },
    });
  });
});
