"use client";

import { useState } from "react";
import { BrandingPanel } from "@/components/admin/branding-panel";
import { normalizeThemeColors, type BrandColors } from "@/lib/branding/theme";
import { reloadBrandingStyles } from "@/lib/branding/client";
import { AdminSettingsFrame } from "./settings-frame";
import { useAdminSettings } from "./use-admin-settings";

/** The instance name, the agent avatar and the accent colours. */
export function BrandingSection() {
  const { settings, loading, saving, saveStatus, save } = useAdminSettings();
  const [colors, setColors] = useState<BrandColors | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  const brandColors = colors ?? normalizeThemeColors(settings?.themeColors);
  const brandAvatar = avatar ?? settings?.brandingAvatar ?? "";
  const brandName = name ?? settings?.workspaceName ?? "";

  const saveBranding = async () => {
    if (!(await save({ themeColors: brandColors, workspaceName: brandName }))) return;
    reloadBrandingStyles();
  };

  return (
    <AdminSettingsFrame
      loading={loading}
      saving={saving}
      status={saveStatus}
      onSave={() => void saveBranding()}
    >
      <BrandingPanel
        flat
        name={brandName}
        onNameChange={setName}
        colors={brandColors}
        onColorsChange={setColors}
        avatar={brandAvatar}
        onAvatarChange={setAvatar}
      />
    </AdminSettingsFrame>
  );
}
