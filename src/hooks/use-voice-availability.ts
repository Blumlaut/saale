"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/http";

/** Whether this deployment transcribes speech, so the composer can offer a mic. */
export function useVoiceAvailability(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let live = true;
    fetchJson<{ enabled: boolean }>("/api/voice")
      .then((data) => {
        if (live) setEnabled(data.enabled);
      })
      .catch((err) => console.error("Failed to read whether voice input is on:", err));
    return () => {
      live = false;
    };
  }, []);

  return enabled;
}
