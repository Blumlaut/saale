"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteJson, fetchJson, putJson } from "@/lib/http";

/**
 * The user's sandbox environment variables.
 *
 * The API only ever returns names, so this hook has no value to hold on to: a
 * value goes in and the response comes back as the new list.
 */
export function useSandboxEnv() {
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ names: string[] }>("/api/settings/sandbox-env");
      setNames(data.names);
    } catch (err) {
      console.error("Failed to load sandbox variables:", err);
      setError(err instanceof Error ? err.message : "Failed to load variables");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setVariable = useCallback(async (name: string, value: string): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const data = await putJson<{ names: string[] }>("/api/settings/sandbox-env", {
        name: name.trim(),
        value,
      });
      setNames(data.names);
      return true;
    } catch (err) {
      console.error("Failed to save sandbox variable:", err);
      setError(err instanceof Error ? err.message : "Failed to save variable");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const removeVariable = useCallback(async (name: string) => {
    setSaving(true);
    setError(null);
    try {
      const data = await deleteJson<{ names: string[] }>(
        `/api/settings/sandbox-env?name=${encodeURIComponent(name)}`,
      );
      setNames(data.names);
    } catch (err) {
      console.error(`Failed to remove sandbox variable ${name}:`, err);
      setError(err instanceof Error ? err.message : "Failed to remove variable");
    } finally {
      setSaving(false);
    }
  }, []);

  return { names, loading, saving, error, setVariable, removeVariable };
}
