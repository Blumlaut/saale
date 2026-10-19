import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  findAdminSettings: vi.fn(),
  findUserSettings: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: mocks.findUser },
    adminSettings: { findUnique: mocks.findAdminSettings },
    appSettings: { findUnique: mocks.findUserSettings },
  },
}));

import {
  loadDefaultFeatures,
  loadUserFeatures,
  resolveFeatures,
  sparseFeatureOverrides,
} from "@/lib/permissions/feature-access";
import {
  FEATURES,
  FEATURE_DEFINITIONS,
  defaultFeatures,
  featureForToolCategory,
  normalizeFeatureOverrides,
} from "@/lib/permissions/features";
import { TOOL_CATEGORIES } from "@/lib/pi/tool-categories";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findAdminSettings.mockResolvedValue({ featureDefaults: null });
  mocks.findUserSettings.mockResolvedValue({ features: null });
});

describe("feature definitions", () => {
  it("describes every feature with a human label and text", () => {
    for (const key of FEATURES) {
      const definition = FEATURE_DEFINITIONS[key];
      expect(definition.label.length).toBeGreaterThan(0);
      // A label that repeats the key is not a label.
      expect(definition.label).not.toBe(key);
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it("points every tool category at exactly one feature, except settings", () => {
    for (const category of TOOL_CATEGORIES) {
      const feature = featureForToolCategory(category.key);
      if (category.key === "settings") {
        expect(feature).toBeUndefined();
        continue;
      }
      expect(feature, category.key).toBeDefined();
    }
  });

  it("maps the shared and one-to-one categories", () => {
    expect(featureForToolCategory("email")).toBe("mail");
    expect(featureForToolCategory("contacts")).toBe("mail");
    expect(featureForToolCategory("terminal")).toBe("terminal");
  });

  it("ships the council off and the everyday modules on", () => {
    const defaults = defaultFeatures();
    expect(defaults.council).toBe(false);
    expect(defaults.mail).toBe(true);
    expect(defaults.terminal).toBe(true);
  });
});

describe("resolveFeatures", () => {
  it("layers instance defaults over the built-ins, and account switches over both", () => {
    const features = resolveFeatures({ mail: false, council: true }, { mail: true, web: false });

    expect(features.mail).toBe(true);
    expect(features.council).toBe(true);
    expect(features.web).toBe(false);
    expect(features.calendar).toBe(true);
  });

  it("ignores unknown keys and non-boolean values", () => {
    const features = resolveFeatures(
      normalizeFeatureOverrides({ nope: true, mail: "yes", web: false }),
    );
    expect(features.web).toBe(false);
    expect(features.mail).toBe(true);
    expect(features).not.toHaveProperty("nope");
  });
});

describe("sparseFeatureOverrides", () => {
  it("stores only the switches that differ from the baseline", () => {
    const baseline = defaultFeatures();
    const overrides = sparseFeatureOverrides({ ...baseline, council: true, mail: false }, baseline);

    expect(overrides).toEqual({ council: true, mail: false });
  });

  it("drops a switch the account put back to the baseline", () => {
    expect(sparseFeatureOverrides({ ...defaultFeatures() }, defaultFeatures())).toEqual({});
  });
});

describe("loadUserFeatures", () => {
  it("gives an admin account everything, without reading any settings", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });

    const features = await loadUserFeatures("admin-1");

    expect(Object.values(features).every(Boolean)).toBe(true);
    expect(mocks.findAdminSettings).not.toHaveBeenCalled();
  });

  it("applies the instance default to a regular account", async () => {
    mocks.findUser.mockResolvedValue({ role: "user" });
    mocks.findAdminSettings.mockResolvedValue({ featureDefaults: { mail: false } });

    const features = await loadUserFeatures("user-1");

    expect(features.mail).toBe(false);
    expect(features.calendar).toBe(true);
  });

  it("lets an account's own switch beat the instance default", async () => {
    mocks.findUser.mockResolvedValue({ role: "user" });
    mocks.findAdminSettings.mockResolvedValue({ featureDefaults: { council: false } });
    mocks.findUserSettings.mockResolvedValue({ features: { council: true } });

    const features = await loadUserFeatures("user-1");

    expect(features.council).toBe(true);
  });

  it("treats a missing account row as a regular account", async () => {
    mocks.findUser.mockResolvedValue(null);

    const features = await loadUserFeatures("ghost");

    expect(features.council).toBe(false);
    expect(features.mail).toBe(true);
  });
});

describe("loadDefaultFeatures", () => {
  it("falls back to the built-in defaults when the row is absent", async () => {
    mocks.findAdminSettings.mockResolvedValue(null);
    expect(await loadDefaultFeatures()).toEqual(defaultFeatures());
  });
});
