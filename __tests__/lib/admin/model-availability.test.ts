import { describe, it, expect } from "vitest";

import {
  fromGlobalProviderModels,
  toGlobalProviderModels,
  type ProviderModelSelection,
} from "@/lib/admin/model-availability";

/**
 * The two directions of the admin's model availability.
 *
 * What matters here is the difference between "the admin selected nothing for
 * this provider" and "the admin never touched this provider": an empty list in
 * the stored column used to hide every model of the provider, so saving the
 * availability tab without touching a provider switched it off. These tests pin
 * the conversion that keeps that from happening.
 */
describe("model availability", () => {
  describe("fromGlobalProviderModels", () => {
    it("reads a switched-off provider as nothing selected", () => {
      const selection = fromGlobalProviderModels({ anthropic: { enabled: false } });

      expect(selection.anthropic).toEqual(new Set());
    });

    it("reads an allowlist as the selected models", () => {
      const selection = fromGlobalProviderModels({
        openai: { enabled: true, models: ["gpt-5", "gpt-5-mini"] },
      });

      expect(selection.openai).toEqual(new Set(["gpt-5", "gpt-5-mini"]));
    });

    it("treats an empty model list as untouched, like a missing entry", () => {
      // The shape a previous Save wrote for providers nobody had toggled.
      const selection = fromGlobalProviderModels({
        custom: { enabled: true, models: [] },
        groq: { enabled: true },
      });

      expect(selection).toEqual({});
    });

    it("ignores a stored value that is not a provider entry", () => {
      for (const stored of [null, undefined, [], "nonsense", 42, { groq: "nonsense" }]) {
        expect(fromGlobalProviderModels(stored)).toEqual({});
      }
    });
  });

  describe("toGlobalProviderModels", () => {
    it("writes no model list for a provider the admin never touched", () => {
      const stored = toGlobalProviderModels(["anthropic", "groq"], {});

      expect(stored).toEqual({
        anthropic: { enabled: true },
        groq: { enabled: true },
      });
      // The regression: `models: []` here meant "every model off".
      expect(stored.anthropic).not.toHaveProperty("models");
    });

    it("writes the provider switch for a provider emptied in the list", () => {
      const selection: ProviderModelSelection = { anthropic: new Set() };

      expect(toGlobalProviderModels(["anthropic"], selection)).toEqual({
        anthropic: { enabled: false },
      });
    });

    it("writes an allowlist for a provider with selected models", () => {
      const selection: ProviderModelSelection = { openai: new Set(["gpt-5"]) };

      expect(toGlobalProviderModels(["openai"], selection)).toEqual({
        openai: { enabled: true, models: ["gpt-5"] },
      });
    });

    it("survives a round trip through the stored shape", () => {
      const selection: ProviderModelSelection = {
        anthropic: new Set(),
        openai: new Set(["gpt-5"]),
      };

      const stored = toGlobalProviderModels(["anthropic", "openai", "groq"], selection);

      expect(fromGlobalProviderModels(stored)).toEqual(selection);
    });

    it("keeps a switched-off provider off after another save", () => {
      const loaded = fromGlobalProviderModels({
        anthropic: { enabled: false },
        groq: { enabled: true },
      });

      const saved = toGlobalProviderModels(["anthropic", "groq"], loaded);

      expect(saved).toEqual({ anthropic: { enabled: false }, groq: { enabled: true } });
    });
  });
});
