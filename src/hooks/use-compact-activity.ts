"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/http";

/** The one settings field this hook reads. */
interface CompactActivitySettings {
  settings: { compactActivity?: boolean };
}

/**
 * Whether the transcript should condense a turn's activity.
 *
 * Read once per chat mount from the user's settings — the transcript is the
 * only consumer, and the settings page owns the write, so a subscription would
 * buy nothing. It starts compact because that is the stored default: a flash of
 * expanded cards is exactly what the setting exists to avoid.
 */
export function useCompactActivity(): boolean {
  const [compactActivity, setCompactActivity] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetchJson<CompactActivitySettings>("/api/settings")
      .then((data) => {
        if (!cancelled) setCompactActivity(data.settings.compactActivity ?? true);
      })
      .catch((err) => {
        console.error("Failed to load the compact activity preference:", err);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return compactActivity;
}
