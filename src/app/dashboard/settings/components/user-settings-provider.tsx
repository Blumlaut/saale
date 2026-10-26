"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fetchJson, patchJson } from "@/lib/http";
import type { UserSettings } from "../types";

interface UserSettingsContextValue {
  settings: UserSettings | null;
  loading: boolean;
  /** A request is in flight. */
  saving: boolean;
  saveStatus: "idle" | "success" | "error";
  /** Replace the local draft. The page's Save button sends it. */
  updateSettings: (settings: UserSettings) => void;
  /** Send the whole draft. */
  save: () => Promise<void>;
  /** Save one change on its own and adopt the server's answer. */
  patch: (patch: Partial<UserSettings>) => Promise<void>;
}

const UserSettingsContext = createContext<UserSettingsContextValue | null>(null);

/**
 * One load of `/api/settings` for the whole settings area, so moving between
 * sections keeps the values in flight. Pages edit a local draft; changes saved
 * on their own (switches, theme) go through `patch` and are adopted from the
 * response so a stale draft cannot undo them.
 */
export function UserSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  useEffect(() => {
    fetchJson<{ settings: UserSettings }>("/api/settings")
      .then((data) => {
        setSettings(data.settings);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load settings:", err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (saveStatus !== "idle") {
      const timer = setTimeout(() => setSaveStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  const save = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await patchJson("/api/settings", settings);
      setSaveStatus("success");
    } catch (err) {
      console.error("Failed to save settings:", err);
      setSaveStatus("error");
    }
    setSaving(false);
  }, [settings]);

  const patch = useCallback(async (change: Partial<UserSettings>) => {
    setSaving(true);
    try {
      const data = await patchJson<{ settings: UserSettings }>("/api/settings", change);
      setSettings(data.settings);
      setSaveStatus("success");
    } catch (err) {
      console.error("Failed to save settings:", err);
      setSaveStatus("error");
    }
    setSaving(false);
  }, []);

  const value = useMemo<UserSettingsContextValue>(
    () => ({ settings, loading, saving, saveStatus, updateSettings: setSettings, save, patch }),
    [settings, loading, saving, saveStatus, save, patch],
  );

  return <UserSettingsContext.Provider value={value}>{children}</UserSettingsContext.Provider>;
}

export function useUserSettings(): UserSettingsContextValue {
  const value = useContext(UserSettingsContext);
  if (!value) {
    throw new Error("useUserSettings must be used within a UserSettingsProvider");
  }
  return value;
}
