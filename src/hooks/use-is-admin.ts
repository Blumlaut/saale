"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/http";

/** Whether the signed-in user has the admin role; false until the session is checked. */
export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    fetchJson<{ user?: { role?: string | null } }>("/api/auth/get-session")
      .then((data) => setIsAdmin(data.user?.role === "admin"))
      .catch((err) => console.error("Failed to check admin status:", err));
  }, []);

  return isAdmin;
}
