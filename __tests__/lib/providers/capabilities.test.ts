import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectModelCapabilities,
  mergeDetectedCapabilities,
  parseModelCapabilityMap,
  parseVisionEdit,
  resolveModelInput,
  serializeModelCapabilityMap,
  configuredVision,
  withModelVision,
  withoutModelVision,
} from "@/lib/providers/capabilities";

/** Stub the endpoint's responses by URL suffix, failing anything unexpected. */
function stubEndpoint(handlers: Record<string, unknown>): void {
  const entries = Object.entries(handlers);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const requested = String(url);
      const match = entries.find(([suffix]) => requested.endsWith(suffix));
      if (!match) return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      return { ok: true, status: 200, json: async () => match[1] };
    }),
  );
}

/** llama.cpp `/props` payload for a vision model. */
function props(modelPath: string, vision: boolean): Record<string, unknown> {
  return {
    model_path: modelPath,
    model_alias: modelPath.split("/").pop()!.replace(".gguf", ""),
    modalities: { vision, audio: false },
    default_generation_settings: { n_ctx: 32768 },
  };
}

describe("parseModelCapabilityMap", () => {
  it("keeps the vision flags and drops entries that carry none", () => {
    expect(
      parseModelCapabilityMap({
        "vision-model": { vision: true },
        "text-model": { vision: false },
        "empty-model": {},
        "wrong-type": { vision: "yes" },
        "not-an-object": 42,
      }),
    ).toEqual({
      "vision-model": { vision: true },
      "text-model": { vision: false },
    });
  });

  it("treats anything that is not a plain object as nothing stored", () => {
    expect(parseModelCapabilityMap(null)).toEqual({});
    expect(parseModelCapabilityMap(undefined)).toEqual({});
    expect(parseModelCapabilityMap(["a"])).toEqual({});
    expect(parseModelCapabilityMap("{}")).toEqual({});
  });
});

describe("withModelVision / withoutModelVision", () => {
  it("sets one model without touching the others", () => {
    const before = { other: { vision: false } };
    expect(withModelVision(before, "vl", true)).toEqual({
      other: { vision: false },
      vl: { vision: true },
    });
    expect(before).toEqual({ other: { vision: false } });
  });

  it("drops the entry entirely when reset to auto", () => {
    expect(withoutModelVision({ vl: { vision: true } }, "vl")).toEqual({});
  });

  it("leaves the model on auto when it had no entry to reset", () => {
    expect(withoutModelVision({}, "vl")).toEqual({});
  });
});

describe("configuredVision / resolveModelInput", () => {
  it("reports a configured flag and nothing when unset", () => {
    expect(configuredVision({ vl: { vision: true } }, "vl")).toBe(true);
    expect(configuredVision({ vl: { vision: false } }, "vl")).toBe(false);
    expect(configuredVision({}, "vl")).toBeUndefined();
  });

  it("falls back to the catalog's input when the user configured nothing", () => {
    expect(resolveModelInput(["text", "image"], undefined)).toEqual(["text", "image"]);
    expect(resolveModelInput(["text"], undefined)).toEqual(["text"]);
    expect(resolveModelInput(undefined, undefined)).toEqual(["text"]);
  });

  it("lets a configured flag overrule the catalog", () => {
    expect(resolveModelInput(["text"], true)).toEqual(["text", "image"]);
    expect(resolveModelInput(["text", "image"], false)).toEqual(["text"]);
  });

  it("copies the catalog input instead of handing out its array", () => {
    const known: ("text" | "image")[] = ["text", "image"];
    const resolved = resolveModelInput(known, undefined);
    resolved.push("text");
    expect(known).toEqual(["text", "image"]);
  });
});

describe("mergeDetectedCapabilities", () => {
  it("takes the endpoint's answer over a stale one", () => {
    expect(mergeDetectedCapabilities({ vl: { vision: false } }, { vl: { vision: true } })).toEqual({
      vl: { vision: true },
    });
  });

  it("keeps what the endpoint could not answer for", () => {
    expect(mergeDetectedCapabilities({ vl: { vision: true } }, {})).toEqual({
      vl: { vision: true },
    });
  });
});

describe("serializeModelCapabilityMap", () => {
  it("writes only set flags, so an 'auto' model has no entry", () => {
    expect(serializeModelCapabilityMap({ vl: { vision: true }, auto: {} })).toEqual({
      vl: { vision: true },
    });
  });
});

describe("parseVisionEdit", () => {
  it("accepts a boolean flag and an explicit reset", () => {
    expect(parseVisionEdit({ modelId: "vl", vision: true })).toEqual({
      modelId: "vl",
      vision: true,
    });
    expect(parseVisionEdit({ modelId: "vl", vision: null })).toEqual({
      modelId: "vl",
      vision: null,
    });
    expect(parseVisionEdit({ modelId: "vl" })).toEqual({ modelId: "vl", vision: null });
  });

  it("rejects a missing model or a non-boolean flag", () => {
    expect(parseVisionEdit({ vision: true })).toHaveProperty("error");
    expect(parseVisionEdit({ modelId: "", vision: true })).toHaveProperty("error");
    expect(parseVisionEdit({ modelId: "vl", vision: "true" })).toHaveProperty("error");
  });
});

describe("detectModelCapabilities", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a single-model llama.cpp server from the unparameterised /props", async () => {
    stubEndpoint({ "/props": props("/models/Qwen3-VL-8B/Qwen3-VL-8B-Q4_K_M.gguf", true) });

    const result = await detectModelCapabilities({
      baseUrl: "http://localhost:8080/v1/",
      modelIds: ["Qwen3-VL-8B"],
    });

    expect(result.capabilities).toEqual({ "Qwen3-VL-8B": { vision: true } });
    expect(result.unprobed).toBe(0);
    const url = String(vi.mocked(globalThis.fetch).mock.calls[0]![0]);
    // `/props` is served from the server root, not under the `/v1` the OpenAI
    // API (and the provider's base URL) lives at; and asking for the model by
    // name would break a server that serves it under a different id.
    expect(url).toBe("http://localhost:8080/props");
  });

  it("records text-only for a single model the server reports without vision", async () => {
    stubEndpoint({ "/props": props("/models/Llama-3-8B/Q4_K_M.gguf", false) });

    const result = await detectModelCapabilities({
      baseUrl: "http://localhost:8080/v1",
      modelIds: ["Llama-3-8B"],
    });

    expect(result.capabilities).toEqual({ "Llama-3-8B": { vision: false } });
  });

  it("keeps a base URL's own path prefix when stripping the API version", async () => {
    stubEndpoint({
      "/llama/props": props("/models/Only/model.gguf", true),
    });

    const result = await detectModelCapabilities({
      baseUrl: "https://gpu.example.com/llama/v1/",
      modelIds: ["Only"],
    });

    expect(result.capabilities).toEqual({ Only: { vision: true } });
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0]![0])).toBe(
      "https://gpu.example.com/llama/props",
    );
  });

  it("asks per model when the server lists several", async () => {
    stubEndpoint({
      "/props?model=Qwen3-VL-8B": props("/models/Qwen3-VL-8B/Qwen3-VL-8B-Q4_K_M.gguf", true),
      "/props?model=Llama-3-8B": props("/models/Llama-3-8B/Llama-3-8B-Q4_K_M.gguf", false),
    });

    const result = await detectModelCapabilities({
      baseUrl: "http://localhost:8080/v1",
      modelIds: ["Qwen3-VL-8B", "Llama-3-8B"],
      apiKey: "local-key",
    });

    expect(result.capabilities).toEqual({
      "Qwen3-VL-8B": { vision: true },
      "Llama-3-8B": { vision: false },
    });
    expect(result.unprobed).toBe(0);
    const headers = vi.mocked(globalThis.fetch).mock.calls[0]![1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer local-key");
  });

  it("refuses to attribute a per-model answer to a different model", async () => {
    // A proxy that ignores `?model=` answers every request with its one loaded
    // model. Attributing that to each listed model would mark a text-only model
    // image-capable, so the answer is discarded.
    stubEndpoint({
      "/props?model=Qwen3-VL-8B": props("/models/Mistral-7B/Q4_K_M.gguf", false),
      "/props?model=Mistral-7B": props("/models/Mistral-7B/Q4_K_M.gguf", false),
    });

    const result = await detectModelCapabilities({
      baseUrl: "http://localhost:8080/v1",
      modelIds: ["Qwen3-VL-8B", "Mistral-7B"],
    });

    // The model that actually answered keeps its (correct) flag; the one the
    // answer was not about stays unknown rather than inheriting it.
    expect(result.capabilities).toEqual({ "Mistral-7B": { vision: false } });
    expect(result.unprobed).toBe(1);
  });

  it("attributes a model directory name, which is what a router serves", async () => {
    stubEndpoint({
      "/props?model=Qwen3-VL-8B": props("/gguf/Qwen3-VL-8B/quant.gguf", true),
      "/props?model=other": {
        model_path: "/gguf/other/model.gguf",
        modalities: { vision: false, audio: false },
      },
    });

    const result = await detectModelCapabilities({
      baseUrl: "http://localhost:8080/v1",
      modelIds: ["Qwen3-VL-8B", "other"],
    });

    expect(result.capabilities).toEqual({
      "Qwen3-VL-8B": { vision: true },
      other: { vision: false },
    });
  });

  it("claims nothing when the endpoint has no capability report", async () => {
    stubEndpoint({});

    const result = await detectModelCapabilities({
      baseUrl: "http://localhost:8080/v1",
      modelIds: ["some-model", "another-model"],
    });

    expect(result.capabilities).toEqual({});
    expect(result.unprobed).toBe(2);
  });

  it("leaves vision unknown when /props reports no modalities", async () => {
    // Older builds answer /props without a `modalities` block. That is missing
    // information, not "no vision" — claiming text-only there would drop images
    // from a model that can see them.
    stubEndpoint({ "/props": { model_path: "/models/mystery.gguf", chat_template: "…" } });

    const result = await detectModelCapabilities({
      baseUrl: "http://localhost:8080/v1",
      modelIds: ["mystery"],
    });

    expect(result.capabilities).toEqual({});
    expect(result.unprobed).toBe(1);
  });

  it("logs a transport failure and keeps going", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    const result = await detectModelCapabilities({
      baseUrl: "http://localhost:8080/v1",
      modelIds: ["a", "b"],
    });

    expect(result.capabilities).toEqual({});
    expect(result.unprobed).toBe(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0]![0])).toContain("capabilities");
  });

  it("stops probing when the budget is spent", async () => {
    stubEndpoint({
      "/props?model=a": props("/models/a/model.gguf", true),
      "/props?model=b": props("/models/b/model.gguf", true),
    });

    const result = await detectModelCapabilities({
      baseUrl: "http://localhost:8080/v1",
      modelIds: ["a", "b"],
      budgetMs: 0,
    });

    expect(result.capabilities).toEqual({});
    expect(result.unprobed).toBe(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reports models beyond the probe cap instead of dropping them silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubEndpoint({
      "/props": props("/models/only/model.gguf", true),
    });
    // 201 ids: the cap is 200, so exactly one is skipped (and logged).
    const modelIds = Array.from({ length: 201 }, (_, i) => `model-${i}`);

    const result = await detectModelCapabilities({
      baseUrl: "http://localhost:8080/v1",
      modelIds,
    });

    expect(result.unprobed).toBe(201);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("probe cap"));
  });
});
