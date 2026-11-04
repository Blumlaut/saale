"use client";

import { useEffect, useState } from "react";

import { fetchJson } from "@/lib/http";
import type { LatestRelease } from "@/lib/updates/release";

export interface AppUpdate {
  /** The release this build came from. */
  current: string;
  latest: LatestRelease | null;
  updateAvailable: boolean;
}

let cached: AppUpdate | null = null;
let inflight: Promise<AppUpdate> | null = null;

/** One request per page load, however many navs mount the footer. */
function load(): Promise<AppUpdate> {
  inflight ??= fetchJson<AppUpdate>("/api/updates").then(
    (update) => {
      cached = update;
      inflight = null;
      return update;
    },
    (err: unknown) => {
      inflight = null;
      throw err;
    },
  );
  return inflight;
}

/**
 * The newest release this instance could move to.
 *
 * `enabled` is the admin check: a signed-in account that cannot act on the
 * answer never asks for it.
 */
export function useAppUpdate(enabled: boolean): AppUpdate | null {
  const [update, setUpdate] = useState<AppUpdate | null>(cached);

  useEffect(() => {
    if (!enabled || cached) return;

    let cancelled = false;
    load().then(
      (value) => {
        if (!cancelled) setUpdate(value);
      },
      (err: unknown) => console.error("Failed to check for a newer release:", err),
    );

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return update;
}
