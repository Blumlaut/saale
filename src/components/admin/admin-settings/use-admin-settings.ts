"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson, patchJson } from "@/lib/http";
import type { AdminSettingsView } from "@/lib/settings/admin-view";

export type AdminSaveStatus = "idle" | "success" | "error";

/** How long the saved or failed line stays up before it goes back to rest. */
const SAVE_STATUS_CLEAR_MS = 3000;

/**
 * The admin settings one page reads and saves.
 */
export function useAdminSettings() {
  const [settings, setSettings] = useState<AdminSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<AdminSaveStatus>("idle");

  useEffect(() => {
    fetchJson<{ settings: AdminSettingsView }>("/api/admin/settings")
      .then((data) => setSettings(data.settings))
      .catch((err) => console.error("Failed to load admin settings:", err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (saveStatus === "idle") return;
    const timer = setTimeout(() => setSaveStatus("idle"), SAVE_STATUS_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  const save = useCallback(async (change: Partial<AdminSettingsView>): Promise<boolean> => {
    setSaving(true);
    try {
      await patchJson("/api/admin/settings", change);
      setSaveStatus("success");
      return true;
    } catch (err) {
      console.error("Failed to save admin settings:", err);
      setSaveStatus("error");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { settings, loading, saving, saveStatus, save };
}
