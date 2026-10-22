import { describe, it, expect } from "vitest";
import { INTEGRATIONS, getIntegration } from "@/lib/integrations/registry";

describe("integration registry", () => {
  describe("getIntegration", () => {
    it("returns manifest for known IDs", () => {
      expect(getIntegration("telegram")!.id).toBe("telegram");
    });

    it("returns undefined for unknown IDs", () => {
      expect(getIntegration("discord")).toBeUndefined();
      expect(getIntegration("slack")).toBeUndefined();
      expect(getIntegration("")).toBeUndefined();
    });

    it("apiBase matches route path", () => {
      expect(getIntegration("telegram")!.apiBase).toBe("/api/integrations/telegram");
    });
  });

  describe("INTEGRATIONS array", () => {
    it("has unique IDs", () => {
      const ids = INTEGRATIONS.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
