import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The usage ledger's write side: which credential pays for a call, which bucket
 * a chat's spend lands in, and what a row ends up holding.
 */

const mocks = vi.hoisted(() => ({
  findOwnKey: vi.fn(),
  createEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    providerApiKey: { findUnique: (...args: unknown[]) => mocks.findOwnKey(...args) },
    usageEvent: { create: (...args: unknown[]) => mocks.createEvent(...args) },
  },
}));

import { chatUsageKind, providerScope, recordUsage } from "@/lib/usage/record";

const USER_ID = "cmvpiak9i00000ro80zbkka6p";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOwnKey.mockResolvedValue(null);
  mocks.createEvent.mockResolvedValue({ id: "ue_1" });
});

describe("providerScope", () => {
  it("bills the account's own key when it holds one for the provider", async () => {
    mocks.findOwnKey.mockResolvedValue({ id: "key_1" });

    await expect(providerScope(USER_ID, "anthropic")).resolves.toBe("own");
  });

  it("bills the workspace when the account inherits the global key", async () => {
    mocks.findOwnKey.mockResolvedValue(null);

    await expect(providerScope(USER_ID, "anthropic")).resolves.toBe("global");
  });
});

describe("chatUsageKind", () => {
  it("counts a chat a watcher opened as an automation", () => {
    expect(chatUsageKind({ projectId: "proj_1", origin: "watcher" })).toBe("automation");
  });

  it("counts a chat with a project as code work", () => {
    expect(chatUsageKind({ projectId: "proj_1", origin: "user" })).toBe("coder");
  });

  it("counts a plain conversation as a chat", () => {
    expect(chatUsageKind({ projectId: null, origin: "user" })).toBe("chat");
  });
});

describe("recordUsage", () => {
  it("writes the call with the scope that pays for it", async () => {
    mocks.findOwnKey.mockResolvedValue({ id: "key_1" });

    await recordUsage({
      userId: USER_ID,
      kind: "job",
      provider: "openai",
      model: "gpt-5",
      inputTokens: 1200,
      outputTokens: 300,
      cacheRead: 400,
      cost: 0.0125,
      billed: true,
      refId: "run_1",
    });

    expect(mocks.createEvent).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        kind: "job",
        provider: "openai",
        model: "gpt-5",
        scope: "own",
        inputTokens: 1200,
        outputTokens: 300,
        cacheRead: 400,
        cacheWrite: 0,
        cost: 0.0125,
        billed: true,
        refId: "run_1",
      },
    });
  });

  it("writes nothing for a call that spent nothing", async () => {
    await recordUsage({ userId: USER_ID, kind: "council", provider: "openai", model: "gpt-5" });

    expect(mocks.findOwnKey).not.toHaveBeenCalled();
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it("keeps a failed write from failing the call it counts", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createEvent.mockRejectedValue(new Error("connection lost"));

    await expect(
      recordUsage({
        userId: USER_ID,
        kind: "chat",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 10,
      }),
    ).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
