import { describe, expect, it } from "vitest";

import {
  enabledModelIds,
  fromGlobalProviderModels,
  setModelsEnabled,
  toGlobalProviderModels,
} from "@/lib/admin/model-availability";

const PROVIDER = "openai";
const ALL_MODELS = ["gpt-5", "gpt-5-mini", "o4"];

describe("setModelsEnabled", () => {
  it("switches off only the models it is given", () => {
    // A provider nobody has touched has everything on, so this is the case a
    // toggle hits first: one model off, the other two stay.
    const next = setModelsEnabled({}, PROVIDER, ALL_MODELS, ["gpt-5-mini"], false);

    expect([...enabledModelIds(next, PROVIDER, ALL_MODELS)]).toEqual(["gpt-5", "o4"]);
  });

  it("covers the rows a search left visible, not the whole provider", () => {
    const filtered = ["gpt-5", "gpt-5-mini"];

    const off = setModelsEnabled({}, PROVIDER, ALL_MODELS, filtered, false);
    expect([...enabledModelIds(off, PROVIDER, ALL_MODELS)]).toEqual(["o4"]);

    const on = setModelsEnabled({}, PROVIDER, ALL_MODELS, filtered, true);
    expect([...enabledModelIds(on, PROVIDER, ALL_MODELS)].sort()).toEqual([...ALL_MODELS].sort());
  });

  it("leaves other providers alone", () => {
    const next = setModelsEnabled(
      { anthropic: new Set(["claude"]) },
      PROVIDER,
      ALL_MODELS,
      ALL_MODELS,
      false,
    );

    expect(next.anthropic).toEqual(new Set(["claude"]));
  });
});

describe("availability round trip", () => {
  it("writes a switched-off provider as one entry, and an untouched one as all on", () => {
    const allOff = setModelsEnabled({}, PROVIDER, ALL_MODELS, ALL_MODELS, false);
    const stored = toGlobalProviderModels([PROVIDER, "groq"], allOff);

    expect(stored[PROVIDER]).toEqual({ enabled: false });
    expect(stored.groq).toEqual({ enabled: true });
    expect(fromGlobalProviderModels(stored)[PROVIDER]).toEqual(new Set());
  });

  it("keeps a partial selection exact through a reload", () => {
    const partial = setModelsEnabled({}, PROVIDER, ALL_MODELS, ["gpt-5"], false);
    const stored = toGlobalProviderModels([PROVIDER], partial);

    expect(stored[PROVIDER]).toEqual({ enabled: true, models: ["gpt-5-mini", "o4"] });
    expect(
      [...enabledModelIds(fromGlobalProviderModels(stored), PROVIDER, ALL_MODELS)].sort(),
    ).toEqual(["gpt-5-mini", "o4"].sort());
  });
});
