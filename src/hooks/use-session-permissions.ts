"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/http";
import type { RolePermissions } from "@/lib/permissions/roles";

/** The signed-in account's role names and the grants they add up to. */
export interface SessionAccess {
  role: string;
  permissions: RolePermissions;
}

// One request per page load, shared by every nav and screen that asks.
let cached: SessionAccess | null = null;
let pending: Promise<SessionAccess | null> | null = null;

function load(): Promise<SessionAccess | null> {
  pending ??= fetchJson<SessionAccess>("/api/permissions")
    .then((data) => {
      const access = data?.permissions ? data : null;
      cached = access;
      return access;
    })
    .catch((err) => {
      console.error("Failed to load session permissions:", err);
      return null;
    });
  return pending;
}

/** Drop the shared cache. tests only. */
export function resetSessionPermissionsCache(): void {
  cached = null;
  pending = null;
}

/**
 * The account's grants, or null until the session resolves.
 *
 * The role decides what the navs and admin screens may offer. the API refuses
 * the same actions, so stale or missing grants only ever hide controls.
 */
export function useSessionPermissions(): SessionAccess | null {
  const [access, setAccess] = useState<SessionAccess | null>(cached);

  useEffect(() => {
    if (cached) {
      setAccess(cached);
      return;
    }
    let active = true;
    void load().then((data) => {
      if (active) setAccess(data);
    });
    return () => {
      active = false;
    };
  }, []);

  return access;
}
