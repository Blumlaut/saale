/**
 * Settings sections registry.
 *
 * The sidebar's Settings entry expands into these, and each one is a page at
 * `/dashboard/settings/<id>`. A new section is one entry here plus its route
 * (`__tests__/lib/navigation/settings-nav.test.ts` fails when the route is
 * missing).
 */

export const SETTINGS_GROUPS = ["you", "assistant", "connections", "account"] as const;

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export const SETTINGS_GROUP_LABELS: Record<SettingsGroup, string> = {
  you: "You",
  assistant: "Assistant",
  connections: "Connections",
  account: "Account",
};

export const SETTINGS_SECTION_IDS = [
  "profile",
  "appearance",
  "notifications",
  "models",
  "personality",
  "tools",
  "memories",
  "email",
  "calendar",
  "integrations",
  "security",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export interface SettingsSection {
  id: SettingsSectionId;
  group: SettingsGroup;
  /** `/dashboard/settings/<id>` */
  href: string;
  label: string;
  /** One line explaining the section, for the phone section picker. */
  description: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "profile",
    group: "you",
    href: "/dashboard/settings/profile",
    label: "Profile",
    description: "Your name, photo and sign-in details",
  },
  {
    id: "appearance",
    group: "you",
    href: "/dashboard/settings/appearance",
    label: "Appearance",
    description: "Theme, activity density and what the sidebar shows",
  },
  {
    id: "notifications",
    group: "you",
    href: "/dashboard/settings/notifications",
    label: "Notifications",
    description: "What Saale tells you about, on this device and by push",
  },
  {
    id: "models",
    group: "assistant",
    href: "/dashboard/settings/models",
    label: "Models",
    description: "Which model handles each job",
  },
  {
    id: "personality",
    group: "assistant",
    href: "/dashboard/settings/personality",
    label: "Personality",
    description: "The instructions the assistant works from",
  },
  {
    id: "tools",
    group: "assistant",
    href: "/dashboard/settings/tools",
    label: "Tools",
    description: "What the assistant may do without asking",
  },
  {
    id: "memories",
    group: "assistant",
    href: "/dashboard/settings/memories",
    label: "Memories",
    description: "What the assistant remembers about you",
  },
  {
    id: "email",
    group: "connections",
    href: "/dashboard/settings/email",
    label: "Mail accounts",
    description: "The mailboxes Saale reads and writes",
  },
  {
    id: "calendar",
    group: "connections",
    href: "/dashboard/settings/calendar",
    label: "Calendars",
    description: "Connected calendars and subscriptions",
  },
  {
    id: "integrations",
    group: "connections",
    href: "/dashboard/settings/integrations",
    label: "Integrations",
    description: "Telegram, MCP servers and sandbox variables",
  },
  {
    id: "security",
    group: "account",
    href: "/dashboard/settings/security",
    label: "Security",
    description: "Password, two-factor sign-in and sessions",
  },
];

/** The route the settings area lives under. */
export const SETTINGS_ROOT = "/dashboard/settings";

/** Where `/dashboard/settings` lands. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "profile";

/** Old `?tab=` values, so bookmarks and push messages still land. */
export const LEGACY_SETTINGS_TABS: Readonly<Record<string, SettingsSectionId>> = {
  ai: "models",
  persona: "personality",
  account: "security",
  appearance: "appearance",
  notifications: "notifications",
  email: "email",
  calendar: "calendar",
  memories: "memories",
  integrations: "integrations",
  // MCP servers were a tab of their own before they moved into integrations.
  mcp: "integrations",
  tools: "tools",
};

/**
 * Where `/dashboard/settings` sends a visitor: the section an old `?tab=` names,
 * or the default one. Unknown and missing tabs both land on the default.
 */
export function resolveSettingsEntry(tab: string | null | undefined): SettingsSectionId {
  if (!tab) return DEFAULT_SETTINGS_SECTION;
  return LEGACY_SETTINGS_TABS[tab] ?? DEFAULT_SETTINGS_SECTION;
}

const SETTINGS_SECTION_BY_ID = new Map<string, SettingsSection>(
  SETTINGS_SECTIONS.map((section) => [section.id, section]),
);

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === "string" && SETTINGS_SECTION_BY_ID.has(value);
}

export function settingsSection(id: SettingsSectionId): SettingsSection {
  const section = SETTINGS_SECTION_BY_ID.get(id);
  if (!section) throw new Error(`Unknown settings section: ${id}`);
  return section;
}

/** The sections of one group, in registry order. */
export function settingsSectionsInGroup(group: SettingsGroup): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => section.group === group);
}

/** The section whose route is the given pathname, if any. */
export function settingsSectionForPath(pathname: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find(
    (section) => pathname === section.href || pathname.startsWith(`${section.href}/`),
  );
}

/** Whether a pathname belongs to the settings area. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_ROOT || pathname.startsWith(`${SETTINGS_ROOT}/`);
}
