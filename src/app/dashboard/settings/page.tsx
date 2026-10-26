import { redirect } from "next/navigation";
import {
  DEFAULT_SETTINGS_SECTION,
  LEGACY_SETTINGS_TABS,
  isSettingsSectionId,
  settingsSection,
} from "@/lib/navigation/settings-nav";

/**
 * `/dashboard/settings` is the entry point, not a page of its own: it lands on
 * the default section, and keeps old `?tab=` links working.
 */
export default async function SettingsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const legacy = tab ? LEGACY_SETTINGS_TABS[tab] : undefined;
  const section = isSettingsSectionId(legacy) ? legacy : DEFAULT_SETTINGS_SECTION;

  redirect(settingsSection(section).href);
}
