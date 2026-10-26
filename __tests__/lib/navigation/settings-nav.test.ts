import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS_SECTION,
  LEGACY_SETTINGS_TABS,
  SETTINGS_GROUPS,
  SETTINGS_ROOT,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_IDS,
  isSettingsPath,
  isSettingsSectionId,
  resolveSettingsEntry,
  settingsSection,
  settingsSectionForPath,
  settingsSectionsInGroup,
} from "@/lib/navigation/settings-nav";

/**
 * The sections registry is what the sidebar and the routes both read, so a
 * section without a page would be a dead nav link and a page without a section
 * would be unreachable.
 */

const SETTINGS_APP_DIR = join(__dirname, "../../../src/app/dashboard/settings");

describe("settings sections registry", () => {
  it("gives every section its own route page", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(
        existsSync(join(SETTINGS_APP_DIR, section.id, "page.tsx")),
        `settings section "${section.id}" has no page at ${section.href}`,
      ).toBe(true);
    }
  });

  it("routes each section under the settings root", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.href).toBe(`${SETTINGS_ROOT}/${section.id}`);
    }
  });

  it("lists every id once, in registry order", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([...SETTINGS_SECTION_IDS]);
  });

  it("groups every section under a known group", () => {
    const grouped = SETTINGS_GROUPS.flatMap((group) =>
      settingsSectionsInGroup(group).map((section) => section.id),
    );
    expect(grouped).toHaveLength(SETTINGS_SECTION_IDS.length);
    expect([...grouped].sort()).toEqual([...SETTINGS_SECTION_IDS].sort());
  });

  it("resolves the default section to a real page", () => {
    expect(isSettingsSectionId(DEFAULT_SETTINGS_SECTION)).toBe(true);
    expect(settingsSection(DEFAULT_SETTINGS_SECTION).href).toBe(
      `${SETTINGS_ROOT}/${DEFAULT_SETTINGS_SECTION}`,
    );
  });

  it("maps a pathname to the section it opens", () => {
    expect(settingsSectionForPath(`${SETTINGS_ROOT}/models`)?.id).toBe("models");
    expect(settingsSectionForPath(`${SETTINGS_ROOT}/security`)?.id).toBe("security");
    expect(settingsSectionForPath(`${SETTINGS_ROOT}/unknown`)).toBeUndefined();
    expect(settingsSectionForPath("/dashboard/chat")).toBeUndefined();
  });

  it("tells the settings area apart from the rest of the dashboard", () => {
    expect(isSettingsPath(SETTINGS_ROOT)).toBe(true);
    expect(isSettingsPath(`${SETTINGS_ROOT}/models`)).toBe(true);
    expect(isSettingsPath("/dashboard/settingsfoo")).toBe(false);
    expect(isSettingsPath("/dashboard/chat")).toBe(false);
  });

  it("resolves the settings entry URL to a section", () => {
    expect(resolveSettingsEntry(null)).toBe(DEFAULT_SETTINGS_SECTION);
    expect(resolveSettingsEntry("memories")).toBe("memories");
    expect(resolveSettingsEntry("ai")).toBe("models");
    expect(resolveSettingsEntry("mcp")).toBe("integrations");
    expect(resolveSettingsEntry("bogus")).toBe(DEFAULT_SETTINGS_SECTION);
  });

  it("points every legacy ?tab= value at a real section", () => {
    for (const [tab, id] of Object.entries(LEGACY_SETTINGS_TABS)) {
      expect(isSettingsSectionId(id), `legacy tab "${tab}" points at "${id}"`).toBe(true);
    }
  });
});
