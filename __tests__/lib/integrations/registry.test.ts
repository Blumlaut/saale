import { describe, it, expect } from "vitest";
import { INTEGRATIONS, INTEGRATION_MAP, getIntegration } from "@/lib/integrations/registry";
import type { IntegrationManifest } from "@/lib/integrations/types";

describe("integration registry", () => {
  describe("INTEGRATIONS array", () => {
    it("has at least two integrations", () => {
      expect(INTEGRATIONS.length).toBeGreaterThanOrEqual(2);
    });

    it("has unique IDs", () => {
      const ids = INTEGRATIONS.map((i) => i.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("includes telegram", () => {
      const telegram = INTEGRATIONS.find((i) => i.id === "telegram");
      expect(telegram).toBeDefined();
      expect(telegram!.name).toBe("Telegram");
      expect(telegram!.apiBase).toBe("/api/integrations/telegram");
    });

    it("includes github", () => {
      const github = INTEGRATIONS.find((i) => i.id === "github");
      expect(github).toBeDefined();
      expect(github!.name).toBe("GitHub");
      expect(github!.apiBase).toBe("/api/integrations/github");
    });

    it("each entry has required fields", () => {
      for (const entry of INTEGRATIONS) {
        expect(entry.id).toBeDefined();
        expect(typeof entry.id).toBe("string");
        expect(entry.name).toBeDefined();
        expect(typeof entry.name).toBe("string");
        expect(entry.name.length).toBeGreaterThan(0);
        expect(entry.description).toBeDefined();
        expect(typeof entry.description).toBe("string");
        expect(entry.icon).toBeDefined();
        // React components can be functions (legacy) or objects (modern JSX)
        expect(typeof entry.icon).toBeOneOf(["function", "object"]);
        expect(entry.color).toBeDefined();
        expect(typeof entry.color).toBe("string");
        expect(entry.apiBase).toBeDefined();
        expect(entry.apiBase.startsWith("/api/integrations/")).toBe(true);
      }
    });
  });

  describe("INTEGRATION_MAP", () => {
    it("has same size as INTEGRATIONS array", () => {
      expect(INTEGRATION_MAP.size).toBe(INTEGRATIONS.length);
    });

    it("has correct keys", () => {
      for (const entry of INTEGRATIONS) {
        expect(INTEGRATION_MAP.has(entry.id)).toBe(true);
      }
    });

    it("values match array entries", () => {
      for (const entry of INTEGRATIONS) {
        expect(INTEGRATION_MAP.get(entry.id)).toBe(entry);
      }
    });
  });

  describe("getIntegration", () => {
    it("returns manifest for known IDs", () => {
      expect(getIntegration("telegram")).toBeDefined();
      expect(getIntegration("telegram")!.id).toBe("telegram");
      expect(getIntegration("github")).toBeDefined();
      expect(getIntegration("github")!.id).toBe("github");
    });

    it("returns undefined for unknown IDs", () => {
      expect(getIntegration("discord")).toBeUndefined();
      expect(getIntegration("slack")).toBeUndefined();
      expect(getIntegration("")).toBeUndefined();
    });

    it("returns correct type", () => {
      const result = getIntegration("telegram");
      if (result) {
        const _manifest: IntegrationManifest = result;
        expect(_manifest).toBeDefined();
      }
    });
  });
});
