import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Prisma, type AppSettings } from "@prisma/client";
import {
  ADMIN_PROPERTIES,
  ALL_PROPERTIES,
  coveredColumns,
  findProperty,
  USER_PROPERTIES,
  type UserProperty,
} from "@/lib/settings/properties";
import { ALL_TOOL_INFOS } from "@/lib/pi/tool-infos";
import { TOOL_CATEGORIES } from "@/lib/pi/tool-categories";
import { getAllPurposes } from "@/lib/pi/purposes";
import {
  isSidebarNavPinned,
  normalizeSidebarNav,
  SIDEBAR_NAV_ITEMS,
} from "@/lib/navigation/sidebar-nav";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Scalar column names of a Prisma model, read from the schema file. */
function scalarColumns(model: string): string[] {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const block = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  const body = block?.[1];
  if (!body) throw new Error(`Model ${model} not found in prisma/schema.prisma`);

  const names: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const match = /^(\w+)\s+(\w+[?[\]]?)/.exec(line);
    const name = match?.[1];
    const type = match?.[2];
    if (!name || !type) continue;
    if (/^(String|Int|Float|Boolean|DateTime|Json|BigInt|Decimal|Bytes)/.test(type)) {
      names.push(name);
    }
  }
  return names;
}

/** A bare AppSettings row with Prisma's defaults, for projection tests. */
function userRow(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "settings-1",
    userId: "user-1",
    defaultModelProvider: "",
    defaultModelName: "",
    defaultThinkingLevel: "default",
    theme: "system",
    compactActivity: true,
    agentCustomInstructions: null,
    emailWritingStyle: null,
    purposeModelOverrides: null,
    disabledModels: null,
    defaultToolConfig: null,
    toolPolicies: null,
    toolExposure: null,
    sidebarItems: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** Apply a property write to a row, the way the writers do. */
function apply(property: UserProperty, row: AppSettings, value: unknown): AppSettings {
  return { ...row, ...property.write(row, value) } as AppSettings;
}

/** A user-scope property by key (throws for unknown or admin keys). */
function userProperty(key: string): UserProperty {
  const property = findProperty(key);
  if (!property) throw new Error(`No property "${key}"`);
  if (property.scope !== "user") throw new Error(`"${key}" is not a user property`);
  return property;
}

// ─── Coverage (the "can't skip the registry" guard) ──────────────────────────

describe("settings registry coverage", () => {
  const INTERNAL: Record<string, string[]> = {
    AppSettings: ["id", "userId", "updatedAt"],
    AdminSettings: ["id", "updatedAt"],
  };

  it("covers every AppSettings column, or declares it internal", () => {
    const covered = new Set(coveredColumns("user"));
    const missing = scalarColumns("AppSettings").filter(
      (column) => !covered.has(column) && !INTERNAL.AppSettings!.includes(column),
    );

    expect(
      missing,
      `Add these to src/lib/settings/properties.ts (or to INTERNAL): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("covers every AdminSettings column, or declares it internal", () => {
    const covered = new Set(coveredColumns("admin"));
    const missing = scalarColumns("AdminSettings").filter(
      (column) => !covered.has(column) && !INTERNAL.AdminSettings!.includes(column),
    );

    expect(
      missing,
      `Add these to src/lib/settings/properties.ts (or to INTERNAL): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("does not claim columns that do not exist", () => {
    const real = new Set([...scalarColumns("AppSettings"), ...scalarColumns("AdminSettings")]);
    const phantom = [...coveredColumns("user"), ...coveredColumns("admin")].filter(
      (column) => !real.has(column),
    );
    expect(phantom).toEqual([]);
  });
});

// ─── Derived coverage ────────────────────────────────────────────────────────

describe("settings registry derivation", () => {
  it("exposes enabled and exposure for every tool category", () => {
    for (const category of TOOL_CATEGORIES) {
      expect(findProperty(`tools.category.${category.key}.enabled`), category.key).toBeDefined();
      expect(findProperty(`tools.category.${category.key}.exposure`), category.key).toBeDefined();
    }
  });

  it("exposes a policy for every tool", () => {
    for (const tool of ALL_TOOL_INFOS) {
      expect(findProperty(`tools.policy.${tool.name}`), tool.name).toBeDefined();
    }
  });

  it("exposes a model for every purpose", () => {
    for (const purpose of getAllPurposes()) {
      expect(findProperty(`models.purpose.${purpose.id}`), purpose.id).toBeDefined();
    }
  });

  it("exposes visibility for every hideable sidebar item", () => {
    for (const item of SIDEBAR_NAV_ITEMS) {
      const property = findProperty(`sidebar.${item.id}.hidden`);
      if (isSidebarNavPinned(item.id)) {
        expect(property, `${item.id} is pinned and must not be settable`).toBeUndefined();
      } else {
        expect(property, item.id).toBeDefined();
      }
    }
  });

  it("has unique keys and non-empty metadata", () => {
    const keys = ALL_PROPERTIES.map((property) => property.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const property of ALL_PROPERTIES) {
      expect(property.label, property.key).not.toBe("");
      expect(property.description, property.key).not.toBe("");
      expect(property.columns.length, property.key).toBeGreaterThan(0);
    }
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("settings validation", () => {
  const accepts = (key: string, value: unknown) => {
    const property = findProperty(key)!;
    return property.schema.safeParse(value).success;
  };

  it("accepts the enumerations it advertises", () => {
    for (const theme of ["light", "dark", "system"]) expect(accepts("theme", theme)).toBe(true);
    for (const level of ["default", "off", "low", "xhigh", "max"])
      expect(accepts("models.thinkingLevel", level)).toBe(true);
    for (const exposure of ["direct", "codemode", "deferred"])
      expect(accepts("tools.category.email.exposure", exposure)).toBe(true);
    for (const policy of ["allow", "auto", "ask", "off"])
      expect(accepts("tools.policy.bash", policy)).toBe(true);
  });

  it("rejects unknown enumerations", () => {
    expect(accepts("theme", "neon")).toBe(false);
    expect(accepts("models.thinkingLevel", "ultra")).toBe(false);
    expect(accepts("tools.category.email.exposure", "banana")).toBe(false);
    expect(accepts("tools.policy.bash", "maybe")).toBe(false);
  });

  it("requires provider:model for model references", () => {
    expect(accepts("models.default", "anthropic:claude-sonnet-4")).toBe(true);
    expect(accepts("models.default", "openrouter:anthropic/claude-sonnet-4")).toBe(true);
    expect(accepts("models.default", "claude-sonnet-4")).toBe(false);
    expect(accepts("models.default", "anthropic:")).toBe(false);
    expect(accepts("models.disabled", ["anthropic:claude-sonnet-4"])).toBe(true);
    expect(accepts("models.disabled", ["claude-sonnet-4"])).toBe(false);
  });
});

// ─── Projections ─────────────────────────────────────────────────────────────

describe("settings projections", () => {
  it("round-trips a scalar", () => {
    const property = userProperty("theme");
    expect(property.read(apply(property, userRow(), "dark"))).toBe("dark");
    // null restores the default.
    expect(property.read(apply(property, userRow({ theme: "dark" }), null))).toBe("system");
  });

  it("stores compact activity and restores it to the default when cleared", () => {
    const property = userProperty("appearance.compactActivity");
    // Compact is the default every user starts on, existing rows included.
    expect(property.read(userRow())).toBe(true);
    expect(property.read(apply(property, userRow(), false))).toBe(false);
    expect(property.read(apply(property, userRow({ compactActivity: false }), null))).toBe(true);
  });

  it("round-trips a model reference pair", () => {
    const property = userProperty("models.default");
    const row = apply(property, userRow(), "openai:gpt-5");
    expect(row.defaultModelProvider).toBe("openai");
    expect(row.defaultModelName).toBe("gpt-5");
    expect(property.read(row)).toBe("openai:gpt-5");

    const cleared = apply(property, row, null);
    expect(cleared.defaultModelProvider).toBe("");
    expect(cleared.defaultModelName).toBe("");
    expect(property.read(cleared)).toBeNull();
  });

  it("keeps the tool config sparse and falls back to category defaults", () => {
    const property = userProperty("tools.category.email.enabled");
    const current = userRow();
    expect(property.read(current)).toBe(true); // default

    const off = apply(property, current, false);
    expect(off.defaultToolConfig).toEqual({ email: false });
    expect(property.read(off)).toBe(false);

    // Writing the default again drops the entry rather than storing it.
    const back = apply(property, off, true);
    expect(back.defaultToolConfig).toBe(Prisma.DbNull);
  });

  it("merges tool exposure without disturbing other categories", () => {
    const email = userProperty("tools.category.email.exposure");
    const infra = userProperty("tools.category.infra.exposure");

    const row = apply(infra, apply(email, userRow(), "direct"), "deferred");
    expect(row.toolExposure).toEqual({ email: "direct", infra: "deferred" });
    expect(email.read(row)).toBe("direct");
    expect(infra.read(row)).toBe("deferred");

    // Each category's default is stored as absence.
    const reset = apply(email, row, "codemode");
    expect(reset.toolExposure).toEqual({ infra: "deferred" });
  });

  it("merges tool policies and drops unknown ones", () => {
    const bash = userProperty("tools.policy.bash");
    const web = userProperty("tools.policy.web_search");

    const row = apply(bash, userRow({ toolPolicies: { "not-a-tool": "allow" } }), "off");
    expect(row.toolPolicies).toEqual({ bash: "off" });

    const both = apply(web, row, "ask");
    expect(both.toolPolicies).toEqual({ bash: "off", web_search: "ask" });
    // web_search's default is allow, so "ask" is stored.
    expect(web.read(both)).toBe("ask");
  });

  it("round-trips a purpose model override and clears it", () => {
    const property = userProperty("models.purpose.email_draft");
    const row = apply(property, userRow(), "anthropic:claude-sonnet-4");
    expect(row.purposeModelOverrides).toEqual({
      email_draft: { provider: "anthropic", model: "claude-sonnet-4" },
    });
    expect(property.read(row)).toBe("anthropic:claude-sonnet-4");

    const cleared = apply(property, row, null);
    expect(cleared.purposeModelOverrides).toBe(Prisma.DbNull);
    expect(property.read(cleared)).toBeNull();
  });

  it("hides a sidebar item and restores an all-default layout to null", () => {
    const property = userProperty("sidebar.mail.hidden");
    const row = apply(property, userRow(), true);

    const entries = normalizeSidebarNav(row.sidebarItems);
    expect(entries.find((entry) => entry.id === "mail")?.hidden).toBe(true);
    expect(property.read(row)).toBe(true);

    const restored = apply(property, row, false);
    expect(restored.sidebarItems).toBe(Prisma.DbNull);
    expect(property.read(restored)).toBe(false);
  });

  it("exposes admin properties only in the admin scope", () => {
    for (const property of ADMIN_PROPERTIES) {
      expect(property.scope).toBe("admin");
      expect(findProperty(property.key)?.scope).toBe("admin");
    }
    for (const property of USER_PROPERTIES) {
      expect(property.scope).toBe("user");
    }
  });
});
