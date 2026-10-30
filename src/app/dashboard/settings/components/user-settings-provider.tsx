"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fetchJson, patchJson } from "@/lib/http";
import type { UserSettings } from "../types";
import { SAVE_STATE_CLEAR_MS, type SaveState } from "./save-state";

interface UserSettingsContextValue {
  settings: UserSettings | null;
  loading: boolean;
  /** A write is queued or in flight. */
  saving: boolean;
  /** What the last write is doing, for the status line. */
  saveState: SaveState;
  /** Show a change and save it. */
  update: (change: Partial<UserSettings>) => void;
  /**
   * Save a change and wait for the answer. For the one page that keeps a draft
   * and a Save button; true when the change landed.
   */
  save: (change: Partial<UserSettings>) => Promise<boolean>;
}

const UserSettingsContext = createContext<UserSettingsContextValue | null>(null);

/**
 * One load of `/api/settings` for the whole settings area, so moving between
 * sections keeps the values in flight.
 *
 * The pages save as they change: `update` shows the change straight away and
 * queues it. Writes go out one at a time and each answer is merged with what is
 * still queued, so two quick changes to the same column cannot land out of
 * order or lose one another.
 */
export function UserSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  /** The newest settings, including changes the server has not seen yet. */
  const latest = useRef<UserSettings | null>(null);
  /** Columns whose newest value is still to be sent. */
  const queued = useRef<Partial<UserSettings>>({});
  const running = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    fetchJson<{ settings: UserSettings }>("/api/settings")
      .then((data) => {
        latest.current = data.settings;
        setSettings(data.settings);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load settings:", err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (saveState !== "saved" && saveState !== "error") return;
    const timer = setTimeout(() => setSaveState("idle"), SAVE_STATE_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [saveState]);

  /** Show a change immediately and queue it for the server. */
  const stage = useCallback((change: Partial<UserSettings>) => {
    if (!latest.current) return false;
    latest.current = { ...latest.current, ...change };
    setSettings(latest.current);
    queued.current = { ...queued.current, ...change };
    return true;
  }, []);

  /** Send the queue, one request at a time. True when the last write landed. */
  const writeQueue = useCallback(async () => {
    let landed = true;
    setSaving(true);
    setSaveState("saving");

    while (Object.keys(queued.current).length > 0) {
      const change = queued.current;
      queued.current = {};
      try {
        const data = await patchJson<{ settings: UserSettings }>("/api/settings", change);
        // Keep anything queued behind this request: it is newer than the answer.
        const next = { ...data.settings, ...queued.current };
        latest.current = next;
        setSettings(next);
        setSaveState("saved");
        landed = true;
      } catch (err) {
        console.error("Failed to save settings:", err);
        setSaveState("error");
        landed = false;
      }
    }

    setSaving(false);
    return landed;
  }, []);

  const flush = useCallback((): Promise<boolean> => {
    if (running.current) return running.current;
    const run = writeQueue();
    running.current = run;
    void run.then(() => {
      if (running.current === run) running.current = null;
    });
    return run;
  }, [writeQueue]);

  /** Send the queue, and anything that landed in it while it was being sent. */
  const drain = useCallback(async (): Promise<boolean> => {
    let landed = await flush();
    while (Object.keys(queued.current).length > 0) landed = await flush();
    return landed;
  }, [flush]);

  const update = useCallback(
    (change: Partial<UserSettings>) => {
      if (!stage(change)) return;
      void drain();
    },
    [stage, drain],
  );

  const save = useCallback(
    (change: Partial<UserSettings>) => (stage(change) ? drain() : Promise.resolve(false)),
    [stage, drain],
  );

  const value = useMemo<UserSettingsContextValue>(
    () => ({ settings, loading, saving, saveState, update, save }),
    [settings, loading, saving, saveState, update, save],
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
