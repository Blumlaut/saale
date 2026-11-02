import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockReadWebTools = vi.fn();
vi.mock("@/lib/web/tool-settings", () => ({
  readWebTools: (...args: unknown[]) => mockReadWebTools(...args),
}));

import { webSearchSection } from "@/lib/pi/processing-state";

/** The instance read is module state, so every test starts from a cold cache. */
async function loadModules() {
  vi.resetModules();
  const [{ readSearchSources, promptSearchSources }, { readSearchInstance }] = await Promise.all([
    import("@/lib/web/prompt"),
    import("@/lib/web/instance"),
  ]);
  return { readSearchSources, promptSearchSources, readSearchInstance };
}

const CONFIG = {
  instance_name: "Saale Dev",
  version: "2026.1",
  categories: ["general", "news", "images"],
  engines: [
    { name: "bing", categories: ["general"], enabled: true },
    { name: "wikipedia", categories: ["general"], enabled: true },
  ],
};

function searchSettings(engines: string[] = [], categories: string[] = ["general"]) {
  return {
    search: { engines, categories, safeSearch: 0, language: "all", resultsPerCall: 10 },
    fetch: { maxChars: 50_000, timeoutMs: 15_000, maxRedirects: 5 },
  };
}

describe("readSearchSources", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(CONFIG), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("names the instance's categories and the operator's defaults", async () => {
    mockReadWebTools.mockResolvedValue(searchSettings([], ["general", "news"]));
    const { readSearchSources } = await loadModules();

    const sources = await readSearchSources();

    expect(sources.categories).toEqual(["general", "news", "images"]);
    expect(sources.defaults).toEqual(["general", "news"]);
    expect(sources.engines).toEqual([]);
  });

  it("carries the engines the operator allows", async () => {
    mockReadWebTools.mockResolvedValue(searchSettings(["bing", "wikipedia"]));
    const { readSearchSources } = await loadModules();

    const sources = await readSearchSources();

    expect(sources.engines).toEqual(["bing", "wikipedia"]);
  });

  it("keeps the instance read for a week", async () => {
    mockReadWebTools.mockResolvedValue(searchSettings());
    const { readSearchInstance } = await loadModules();
    await readSearchInstance();
    const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    await readSearchInstance();

    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
  });

  it("leaves the categories empty when the instance does not answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );
    mockReadWebTools.mockResolvedValue(searchSettings());
    const { readSearchSources } = await loadModules();

    const sources = await readSearchSources();

    expect(sources.categories).toEqual([]);
    expect(sources.defaults).toEqual(["general"]);
  });
});

describe("webSearchSection", () => {
  it("lists the instance's categories and the defaults", () => {
    const section = webSearchSection({
      categories: ["general", "news", "images"],
      defaults: ["general"],
      engines: [],
    });

    expect(section).toContain("web_search");
    expect(section).toContain("general, news, images");
    expect(section).toContain("names no category uses general");
    expect(section).not.toContain("limited to these engines");
  });

  it("names the allowed engines when the operator narrowed them", () => {
    const section = webSearchSection({
      categories: ["general"],
      defaults: ["general"],
      engines: ["bing", "wikipedia"],
    });

    expect(section).toContain("limited to these engines: bing, wikipedia");
  });

  it("falls back to SearXNG's own vocabulary without an instance", () => {
    const section = webSearchSection({ categories: [], defaults: ["general"], engines: [] });

    expect(section).toContain("SearXNG's category names");
    expect(section).toContain("names no category uses general");
  });
});

describe("promptSearchSources", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(CONFIG), { status: 200 })),
    );
    mockReadWebTools.mockResolvedValue(searchSettings());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reads nothing for a session without the web tools", async () => {
    const { promptSearchSources } = await loadModules();

    expect(await promptSearchSources({ web: false })).toBeUndefined();
    expect(mockReadWebTools).not.toHaveBeenCalled();
  });

  it("reads the sources for a session that can search", async () => {
    const { promptSearchSources } = await loadModules();

    expect(await promptSearchSources({ web: true })).toEqual({
      categories: ["general", "news", "images"],
      defaults: ["general"],
      engines: [],
    });
  });

  it("returns nothing rather than failing a session when the settings cannot be read", async () => {
    mockReadWebTools.mockRejectedValue(new Error("no database"));
    const { promptSearchSources } = await loadModules();

    expect(await promptSearchSources({ web: true })).toBeUndefined();
  });
});
