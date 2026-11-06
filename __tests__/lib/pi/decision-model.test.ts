import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    adminSettings: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));

import { getRedis, resetMockRedis } from "../../helpers/in-memory-redis";
import * as db from "@/lib/db";
import {
  CACHE_MAX_ARGS_CHARS,
  CACHE_TTL_SECONDS,
  judgeToolCall,
  parseDecisionModel,
  resolveApprovalDecisionModel,
  RISK_ASK_ABOVE,
} from "@/lib/pi/decision-model";

type Registry = Parameters<typeof judgeToolCall>[0]["registry"];

/** A classifier Pi knows, so `findOfType` has something to hand back. */
const CLASSIFIER = {
  id: "kev",
  name: "kev",
  type: "classifier",
  api: "typesafe-system-one",
  provider: "custom-llamacpp",
  baseUrl: "http://127.0.0.1:8080/v1",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
};

/** A registry that finds the model and answers with what `answer` says. */
function fakeRegistry(answer: unknown, options: { found?: boolean } = {}): Registry {
  return {
    findOfType: vi.fn(() => (options.found === false ? undefined : CLASSIFIER)),
    classify: vi.fn().mockResolvedValue(answer),
  } as unknown as Registry;
}

/** A classifier result carrying one bool answer. */
function result(overrides: Record<string, unknown> = {}) {
  return {
    api: "typesafe-system-one",
    provider: "custom-llamacpp",
    model: "kev",
    answers: { risky: { type: "bool", probability: 0.9 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("parseDecisionModel", () => {
  it("reads a stored provider:model reference", () => {
    expect(parseDecisionModel("custom-llamacpp:kev")).toEqual({
      provider: "custom-llamacpp",
      id: "kev",
    });
  });

  it("reads nothing as no model", () => {
    expect(parseDecisionModel(null)).toBeNull();
    expect(parseDecisionModel("")).toBeNull();
    expect(parseDecisionModel("kev")).toBeNull();
  });
});

describe("resolveApprovalDecisionModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.prisma.adminSettings.findUnique).mockResolvedValue(null);
  });

  it("prefers the account's own pick", async () => {
    vi.mocked(db.prisma.adminSettings.findUnique).mockResolvedValue({
      approvalDecisionModel: "custom-llamacpp:laya",
    } as never);

    await expect(resolveApprovalDecisionModel("custom-llamacpp:kev")).resolves.toEqual({
      provider: "custom-llamacpp",
      id: "kev",
    });
  });

  it("follows the instance default when the account has no pick", async () => {
    vi.mocked(db.prisma.adminSettings.findUnique).mockResolvedValue({
      approvalDecisionModel: "custom-llamacpp:laya",
    } as never);

    await expect(resolveApprovalDecisionModel(null)).resolves.toEqual({
      provider: "custom-llamacpp",
      id: "laya",
    });
  });

  it("resolves nothing when neither side picked a model", async () => {
    await expect(resolveApprovalDecisionModel(null)).resolves.toBeNull();
  });
});

describe("judgeToolCall", () => {
  const call = { toolName: "bash", input: { command: "rm -rf build" } };
  const model = { provider: "custom-llamacpp", id: "kev" };

  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMockRedis();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("lets a call run when the model is confident it is safe", async () => {
    const registry = fakeRegistry(
      result({ answers: { risky: { type: "bool", probability: 0.05 } } }),
    );

    await expect(judgeToolCall({ ...call, model, registry })).resolves.toBe("safe");
  });

  it("asks the user once the model is confident it is risky", async () => {
    const registry = fakeRegistry(
      result({ answers: { risky: { type: "bool", probability: RISK_ASK_ABOVE } } }),
    );

    await expect(judgeToolCall({ ...call, model, registry })).resolves.toBe("risky");
  });

  it("puts the call to the model as the tool and its arguments", async () => {
    const registry = fakeRegistry(result());

    await judgeToolCall({ ...call, model, registry });

    const [classifier, context] = vi.mocked(registry.classify).mock.calls[0]!;
    expect(classifier).toBe(CLASSIFIER);
    expect(context.state).toEqual({ tool: "bash", arguments: { command: "rm -rf build" } });
    expect(context.questions.risky).toMatchObject({ type: "bool" });
  });

  // Everything that is not an answer has to leave the decision to the caller's
  // fallback: a missing model is not a yes.
  it("decides nothing when the model is not registered", async () => {
    const registry = fakeRegistry(result(), { found: false });

    await expect(judgeToolCall({ ...call, model, registry })).resolves.toBeNull();
    expect(registry.classify).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("decides nothing when the model fails to answer", async () => {
    const registry = fakeRegistry(result({ stopReason: "error", errorMessage: "offline" }));

    await expect(judgeToolCall({ ...call, model, registry })).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("decides nothing when the call throws", async () => {
    const registry = fakeRegistry(result());
    vi.mocked(registry.classify).mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(judgeToolCall({ ...call, model, registry })).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  describe("remembered verdicts", () => {
    /** A registry whose every answer is the same bool probability. */
    function answering(probability: number) {
      return fakeRegistry(result({ answers: { risky: { type: "bool", probability } } }));
    }

    it("answers a repeated call without asking the model again", async () => {
      const registry = answering(0.02);

      await expect(judgeToolCall({ ...call, model, registry })).resolves.toBe("safe");
      await expect(judgeToolCall({ ...call, model, registry })).resolves.toBe("safe");

      expect(registry.classify).toHaveBeenCalledTimes(1);
    });

    it("stores no part of the call itself", async () => {
      const registry = answering(0.02);
      await judgeToolCall({ ...call, model, registry });

      const [, keys] = await getRedis().scan("0", "MATCH", "saale:decision:*", "COUNT", 100);
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toContain("rm -rf");
      expect(keys[0]).not.toContain("build");
    });

    // Long on purpose: the model is part of the key, so a verdict only goes
    // stale when a different model answers the same call.
    it("keeps the verdict for weeks", async () => {
      const registry = answering(0.02);
      await judgeToolCall({ ...call, model, registry });

      const [, keys] = await getRedis().scan("0", "MATCH", "saale:decision:*", "COUNT", 100);
      expect(CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
      expect(await getRedis().ttl(keys[0]!)).toBeGreaterThan(CACHE_TTL_SECONDS - 60);
    });

    // A borderline answer is the one worth asking again: a model that is only
    // 60% sure has not earned a standing decision.
    it("keeps judging a safe answer it was not sure about", async () => {
      const registry = answering(0.5);

      await judgeToolCall({ ...call, model, registry });
      await judgeToolCall({ ...call, model, registry });

      expect(registry.classify).toHaveBeenCalledTimes(2);
    });

    it("remembers nothing about a risky call", async () => {
      const registry = answering(0.93);

      await expect(judgeToolCall({ ...call, model, registry })).resolves.toBe("risky");
      await expect(judgeToolCall({ ...call, model, registry })).resolves.toBe("risky");

      expect(registry.classify).toHaveBeenCalledTimes(2);
    });

    // The model is part of the key, so a switch cannot reuse a verdict the
    // previous one gave.
    it("judges afresh under another model", async () => {
      const registry = answering(0.02);

      await judgeToolCall({ ...call, model, registry });
      await judgeToolCall({
        ...call,
        model: { provider: "custom-llamacpp", id: "laya" },
        registry,
      });

      expect(registry.classify).toHaveBeenCalledTimes(2);
    });

    it("remembers nothing about a long call", async () => {
      const registry = answering(0.02);
      const long = { command: "x".repeat(CACHE_MAX_ARGS_CHARS + 1) };

      await judgeToolCall({ toolName: "bash", input: long, model, registry });
      await judgeToolCall({ toolName: "bash", input: long, model, registry });

      expect(registry.classify).toHaveBeenCalledTimes(2);
    });

    it("remembers nothing when the model did not answer", async () => {
      const registry = fakeRegistry(result({ stopReason: "error", errorMessage: "offline" }));

      await judgeToolCall({ ...call, model, registry });
      await judgeToolCall({ ...call, model, registry });

      expect(registry.classify).toHaveBeenCalledTimes(2);
    });

    // A model that is gone must ask, whatever it said before it went.
    it("does not answer from the cache when the model is unregistered", async () => {
      await judgeToolCall({ ...call, model, registry: answering(0.02) });

      const gone = fakeRegistry(result(), { found: false });
      await expect(judgeToolCall({ ...call, model, registry: gone })).resolves.toBeNull();
    });
  });

  it("decides nothing when the answer is not the question it asked", async () => {
    const registry = fakeRegistry(result({ answers: { risky: { type: "choice", choice: "x" } } }));

    await expect(judgeToolCall({ ...call, model, registry })).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });
});
