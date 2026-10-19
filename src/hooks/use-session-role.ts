"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/http";

/**
 * The signed-in account's role string, or null until the session resolves.
 *
 * The role decides what the navs and admin screens may offer — the API refuses
 * the same actions, so a stale or missing role only ever hides controls.
 */
export function useSessionRole(): string | null {
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<{ user?: { role?: string | null } }>("/api/auth/get-session")
      .then((data) => setRole(data.user?.role ?? "user"))
      .catch((err) => console.error("Failed to load the session role:", err));
  }, []);

  return role;
}
