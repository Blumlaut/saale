import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdminSettings, AppSettings } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  upsertUserSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  upsertAdminSettings: vi.fn(),
  updateAdminSettings: vi.fn(),
  evictUserSessions: vi.fn(),
  evictAllSessions: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: mocks.findUser },
    appSettings: {
      upsert: mocks.upsertUserSettings,
      update: mocks.updateUserSettings,
    },
    adminSettings: {
      upsert: mocks.upsertAdminSettings,
      update: mocks.updateAdminSettings,
    },
  },
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  evictUserSessions: mocks.evictUserSessions,
  evictAllSessions: mocks.evictAllSessions,
}));

import {
  applyAdminSettingsPatch,
  applyUserSettingsPatch,
  isAdminUser,
  listSettings,
  setSetting,
  SettingsError,
} from "@/lib/settings/update";

const USER_ID = "user-1";

function userRow(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "settings-1",
    userId: USER_ID,
    defaultModelProvider: "",
    defaultModelName: "",
    defaultThinkingLevel: "default",
    theme: "system",
    compactActivity: true,
    agentCustomInstructions: null,
    coderCustomInstructions: null,
    emailWritingStyle: null,
    purposeModelOverrides: null,
    disabledModels: null,
    defaultToolConfig: null,
    coderToolConfig: null,
    toolPolicies: null,
    toolExposure: null,
    sidebarItems: null,
    pushNotifications: null,
    features: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

function adminRow(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    id: "global",
    signupsEnabled: true,
    globalModelProvider: "",
    globalModelName: "",
    globalProviderModels: null,
    featureDefaults: null,
    piPluginsDir: "",
    piPluginsEnabled: false,
    piPluginStates: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** Arguments of the last call to a mock. */
function lastArgs(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const args = mock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
  if (!args) throw new Error("mock was not called");
  return args;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUser.mockResolvedValue({ role: "user" });
  mocks.upsertUserSettings.mockResolvedValue(userRow());
  mocks.updateUserSettings.mockImplementation(async ({ data }: { data: object }) => ({
    ...userRow(),
    ...data,
  }));
  mocks.upsertAdminSettings.mockResolvedValue(adminRow());
  mocks.updateAdminSettings.mockImplementation(async ({ data }: { data: object }) => ({
    ...adminRow(),
    ...data,
  }));
  mocks.evictUserSessions.mockResolvedValue(1);
  mocks.evictAllSessions.mockResolvedValue(3);
});

describe("isAdminUser", () => {
  it("is true only for the admin role", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });
    expect(await isAdminUser(USER_ID)).toBe(true);

    mocks.findUser.mockResolvedValue({ role: "user" });
    expect(await isAdminUser(USER_ID)).toBe(false);

    mocks.findUser.mockResolvedValue(null);
    expect(await isAdminUser(USER_ID)).toBe(false);
  });
});

describe("listSettings", () => {
  it("omits admin settings for a regular user", async () => {
    const views = await listSettings(USER_ID);

    expect(views.some((view) => view.key === "theme")).toBe(true);
    expect(views.some((view) => view.scope === "admin")).toBe(false);
    // The admin row is never even loaded.
    expect(mocks.upsertAdminSettings).not.toHaveBeenCalled();
  });

  it("includes admin settings for an admin", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });

    const views = await listSettings(USER_ID);

    const admin = views.find((view) => view.key === "admin.signupsEnabled");
    expect(admin).toBeDefined();
    expect(admin!.value).toBe(true);
  });

  it("filters by group prefix and by exact key", async () => {
    const byKey = await listSettings(USER_ID, { key: "models.default" });
    expect(byKey.map((view) => view.key)).toEqual(["models.default"]);

    const byGroup = await listSettings(USER_ID, { group: "tools.category.email" });
    expect(byGroup.map((view) => view.key).sort()).toEqual([
      "tools.category.email.enabled",
      "tools.category.email.exposure",
    ]);
  });
});

describe("setSetting", () => {
  it("rejects an unknown key", async () => {
    await expect(setSetting(USER_ID, "not.a.setting", 1)).rejects.toThrow(SettingsError);
    expect(mocks.updateUserSettings).not.toHaveBeenCalled();
  });

  it("rejects an invalid value", async () => {
    await expect(setSetting(USER_ID, "theme", "neon")).rejects.toThrow(/Invalid value/);
    expect(mocks.updateUserSettings).not.toHaveBeenCalled();
  });

  it("writes a scalar and reports the stored value", async () => {
    const view = await setSetting(USER_ID, "theme", "dark");

    expect(view.value).toBe("dark");
    expect(lastArgs(mocks.updateUserSettings)).toEqual({
      where: { userId: USER_ID },
      data: { theme: "dark" },
    });
  });

  it("resets to the default with null", async () => {
    await setSetting(USER_ID, "theme", null);

    expect(lastArgs(mocks.updateUserSettings).data).toEqual({ theme: "system" });
  });

  it("evicts pooled sessions for a setting that feeds them", async () => {
    await setSetting(USER_ID, "tools.category.email.enabled", false);

    expect(mocks.evictUserSessions).toHaveBeenCalledWith(USER_ID);
  });

  it("turns one notification category off without touching the others", async () => {
    const view = await setSetting(USER_ID, "notifications.email", false);

    expect(view.value).toBe(false);
    expect(lastArgs(mocks.updateUserSettings).data).toEqual({
      pushNotifications: { email: false },
    });
    // A notification switch does not shape an agent session.
    expect(mocks.evictUserSessions).not.toHaveBeenCalled();
  });

  it("does not evict for a setting sessions do not read", async () => {
    await setSetting(USER_ID, "theme", "light");

    expect(mocks.evictUserSessions).not.toHaveBeenCalled();
  });

  it("refuses an admin setting for a regular user", async () => {
    await expect(setSetting(USER_ID, "admin.signupsEnabled", false)).rejects.toThrow(
      /administrator/,
    );
    expect(mocks.updateAdminSettings).not.toHaveBeenCalled();
  });

  it("allows an admin to change an admin setting", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });

    const view = await setSetting(USER_ID, "admin.signupsEnabled", false);

    expect(view.value).toBe(false);
    expect(lastArgs(mocks.updateAdminSettings)).toEqual({
      where: { id: "global" },
      data: { signupsEnabled: false },
    });
  });

  it("never writes a user setting to the admin table", async () => {
    await setSetting(USER_ID, "models.default", "openai:gpt-5");

    expect(lastArgs(mocks.updateUserSettings).data).toEqual({
      defaultModelProvider: "openai",
      defaultModelName: "gpt-5",
    });
    expect(mocks.updateAdminSettings).not.toHaveBeenCalled();
  });
});

describe("applyUserSettingsPatch", () => {
  it("ignores columns no property owns", async () => {
    await applyUserSettingsPatch(USER_ID, { notAColumn: "x", theme: "dark" });

    expect(lastArgs(mocks.updateUserSettings).data).toEqual({ theme: "dark" });
  });

  it("rejects a value that fails its property's validation", async () => {
    await expect(
      applyUserSettingsPatch(USER_ID, { defaultThinkingLevel: "ultra" }),
    ).rejects.toThrow(SettingsError);
    expect(mocks.updateUserSettings).not.toHaveBeenCalled();
  });

  it("folds properties that share a column instead of clobbering", async () => {
    await applyUserSettingsPatch(USER_ID, {
      defaultToolConfig: { email: false, tasks: false },
    });

    expect(lastArgs(mocks.updateUserSettings).data).toEqual({
      defaultToolConfig: { email: false, tasks: false },
    });
  });

  it("normalizes a stored blob, dropping unknown entries", async () => {
    await applyUserSettingsPatch(USER_ID, {
      toolPolicies: { bash: "off", "not-a-tool": "allow" },
    });

    expect(lastArgs(mocks.updateUserSettings).data).toEqual({
      toolPolicies: { bash: "off" },
    });
  });

  it("rejects an invalid value inside a blob", async () => {
    await expect(
      applyUserSettingsPatch(USER_ID, { toolPolicies: { bash: "bogus" } }),
    ).rejects.toThrow(SettingsError);
    expect(mocks.updateUserSettings).not.toHaveBeenCalled();
  });

  it("evicts when a touched column feeds a session", async () => {
    await applyUserSettingsPatch(USER_ID, { agentCustomInstructions: "be terse" });

    expect(mocks.evictUserSessions).toHaveBeenCalledWith(USER_ID);
  });

  it("does not evict for a change sessions do not read", async () => {
    await applyUserSettingsPatch(USER_ID, { sidebarItems: null });

    expect(mocks.evictUserSessions).not.toHaveBeenCalled();
  });

  it("keeps a notification switch sparse on the column it shares", async () => {
    await applyUserSettingsPatch(USER_ID, {
      pushNotifications: { chatDone: true, coderDone: true, calendar: true, email: false },
    });

    expect(lastArgs(mocks.updateUserSettings).data).toEqual({
      pushNotifications: { email: false },
    });
  });

  it("returns the current row unchanged when no known column is patched", async () => {
    const row = await applyUserSettingsPatch(USER_ID, { nonsense: true });

    expect(row.userId).toBe(USER_ID);
    expect(mocks.updateUserSettings).not.toHaveBeenCalled();
  });
});

describe("applyAdminSettingsPatch", () => {
  it("refuses a non-admin", async () => {
    await expect(applyAdminSettingsPatch(USER_ID, { signupsEnabled: false })).rejects.toThrow(
      SettingsError,
    );
    expect(mocks.updateAdminSettings).not.toHaveBeenCalled();
  });

  it("writes a valid patch for an admin", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });

    await applyAdminSettingsPatch(USER_ID, { signupsEnabled: false, notAColumn: 1 });

    expect(lastArgs(mocks.updateAdminSettings)).toEqual({
      where: { id: "global" },
      data: { signupsEnabled: false },
    });
  });

  it("rebuilds every pooled session for a global plugin setting", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });

    await applyAdminSettingsPatch(USER_ID, { piPluginsEnabled: true });

    expect(lastArgs(mocks.updateAdminSettings).data).toEqual({ piPluginsEnabled: true });
    expect(mocks.evictAllSessions).toHaveBeenCalled();
    expect(mocks.evictUserSessions).not.toHaveBeenCalled();
  });

  it("rebuilds only the acting admin's sessions for a non-global setting", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });

    await applyAdminSettingsPatch(USER_ID, {
      globalProviderModels: { openai: { enabled: false } },
    });

    expect(mocks.evictUserSessions).toHaveBeenCalledWith(USER_ID);
    expect(mocks.evictAllSessions).not.toHaveBeenCalled();
  });

  it("does not rebuild anything when the plugin set did not change", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });
    mocks.upsertAdminSettings.mockResolvedValue(adminRow({ piPluginsEnabled: true }));

    await applyAdminSettingsPatch(USER_ID, { piPluginsEnabled: true });

    expect(mocks.evictAllSessions).not.toHaveBeenCalled();
  });

  it("rejects an invalid admin value", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });

    await expect(
      applyAdminSettingsPatch(USER_ID, { globalProviderModels: "not-an-object" }),
    ).rejects.toThrow(SettingsError);
    expect(mocks.updateAdminSettings).not.toHaveBeenCalled();
  });
});
