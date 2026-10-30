"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteJson, fetchJson, postJson } from "@/lib/http";
import type { GithubStatus } from "@/lib/integrations/github";

/** Before the first read: nothing known, so nothing claimed. */
const UNKNOWN: GithubStatus = { credential: null, pending: null, error: null };

/**
 * The GitHub sign-in of the user's workspace.
 *
 * The API answers with what `gh` reports, so this hook holds no token: it starts
 * a sign-in, reads the code gh printed and asks again until GitHub is done with
 * it.
 */
export function useGithub() {
  const [status, setStatus] = useState<GithubStatus>(UNKNOWN);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<GithubStatus | null> => {
    try {
      const data = await fetchJson<GithubStatus>("/api/integrations/github");
      setStatus(data);
      return data;
    } catch (err) {
      console.error("Failed to read the GitHub sign-in:", err);
      setError(err instanceof Error ? err.message : "Failed to read the GitHub sign-in");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const start = useCallback(async (): Promise<boolean> => {
    setStarting(true);
    setError(null);
    try {
      setStatus(await postJson<GithubStatus>("/api/integrations/github", {}));
      return true;
    } catch (err) {
      console.error("Failed to start a GitHub sign-in:", err);
      setError(err instanceof Error ? err.message : "Failed to start the GitHub sign-in");
      return false;
    } finally {
      setStarting(false);
    }
  }, []);

  /** Stop a sign-in in flight, or sign out of GitHub, whichever is left to do. */
  const disconnect = useCallback(async (): Promise<void> => {
    setDisconnecting(true);
    setError(null);
    try {
      setStatus(await deleteJson<GithubStatus>("/api/integrations/github"));
    } catch (err) {
      console.error("Failed to sign out of GitHub:", err);
      setError(err instanceof Error ? err.message : "Failed to sign out of GitHub");
    } finally {
      setDisconnecting(false);
    }
  }, []);

  return { status, loading, starting, disconnecting, error, load, start, disconnect };
}
