"use client";

import { Loader2 } from "lucide-react";
import { UserSettingsProvider, useUserSettings } from "./user-settings-provider";
import { SettingsSectionPicker } from "./settings-section-picker";

/**
 * Frame for every settings page: one settings load for the area, and the phone
 * section picker above the content. The desktop nav lives in the sidebar.
 */
export function SettingsShell({ children }: { children: React.ReactNode }) {
  return (
    <UserSettingsProvider>
      <div className="flex h-full min-h-0 flex-col gap-3">
        <SettingsSectionPicker />
        <SettingsContent>{children}</SettingsContent>
      </div>
    </UserSettingsProvider>
  );
}

function SettingsContent({ children }: { children: React.ReactNode }) {
  const { loading } = useUserSettings();

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return <div className="min-h-0 flex-1">{children}</div>;
}
