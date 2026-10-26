"use client";

import { usePathname } from "next/navigation";
import { SectionPicker, type SectionPickerGroup } from "@/components/layout/section-picker";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_GROUPS,
  SETTINGS_GROUP_LABELS,
  settingsSection,
  settingsSectionForPath,
  settingsSectionsInGroup,
} from "@/lib/navigation/settings-nav";

/**
 * Phone navigation for settings. The sections live in the desktop sidebar.
 */
export function SettingsSectionPicker() {
  const pathname = usePathname();
  const current = settingsSectionForPath(pathname) ?? settingsSection(DEFAULT_SETTINGS_SECTION);

  const groups: SectionPickerGroup[] = SETTINGS_GROUPS.map((group) => ({
    label: SETTINGS_GROUP_LABELS[group],
    items: settingsSectionsInGroup(group).map((section) => ({
      id: section.id,
      href: section.href,
      label: section.label,
      description: section.description,
    })),
  })).filter((group) => group.items.length > 0);

  return (
    <SectionPicker
      areaLabel="Settings"
      current={{
        id: current.id,
        href: current.href,
        label: current.label,
        description: current.description,
      }}
      groups={groups}
    />
  );
}
