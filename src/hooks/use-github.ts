"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson, postJson } from "@/lib/http";
import type { GithubAppSection, GithubStatus } from "@/lib/integrations/github";

export type { GithubAppSection };

/** Both sources as the API reports them, and the errors a call can raise. */
interface GithubConnection {
  app: GithubAppSection;
  cli: GithubStatus;
}

/** One installation's repository set, which the card shows as it is. */
export interface GithubInstallationRepositories {
  installationId: string;
  accountLogin: string;
  /** "User" | "Organization" — decides where GitHub's settings page lives. */
  accountType: string;
  selection: string;
  installed: { id: string; name: string; fullName: string }[];
}

/** A read either way: the set, or the sentence that says why there is none. */
export interface GithubRepositoriesAnswer {
  repositories: GithubInstallationRepositories | null;
  error: string | null;
}

/** Before the first read: nothing known, so nothing claimed. */
const UNKNOWN_APP: GithubAppSection = {
  configured: false,
  slug: null,
  name: null,
  permissions: null,
  authorized: null,
  installations: [],
  pending: null,
};

/** Nothing known about the CLI either. */
const UNKNOWN_CLI: GithubStatus = { credential: null, pending: null, error: null };

/** How often the card asks again while a code is out. */
const POLL_MS = 3000;

/**
 * The GitHub connection of this account, in both forms it can take.
 *
 * The hook holds no token: the API answers with what the app and the CLI report,
 * and a status read is also what drives an app sign-in forward, so polling is all
 * a waiting card has to do.
 */
export function useGithub() {
  const [app, setApp] = useState<GithubAppSection>(UNKNOWN_APP);
  const [cli, setCli] = useState<GithubStatus>(UNKNOWN_CLI);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((data: GithubConnection) => {
    setApp(data.app);
    setCli(data.cli);
  }, []);

  const load = useCallback(async (): Promise<GithubConnection | null> => {
    try {
      const data = await fetchJson<GithubConnection>("/api/integrations/github");
      apply(data);
      return data;
    } catch (err) {
      console.error("Failed to read the GitHub connection:", err);
      setError(err instanceof Error ? err.message : "Failed to read the GitHub connection");
      return null;
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  /** While a code is out, the browser may approve it at any moment. */
  useEffect(() => {
    if (!app.pending && !cli.pending) return;
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [app.pending, cli.pending, load]);

  /** A login made elsewhere (the workspace terminal) shows up on focus again. */
  useEffect(() => {
    const onFocus = () => {
      void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const connect = useCallback(async (): Promise<boolean> => {
    setStarting(true);
    setError(null);
    try {
      const data = await postJson<GithubConnection>("/api/integrations/github", {});
      apply(data);
      return true;
    } catch (err) {
      console.error("Failed to start a GitHub sign-in:", err);
      setError(err instanceof Error ? err.message : "Failed to start the GitHub sign-in");
      return false;
    } finally {
      setStarting(false);
    }
  }, [apply]);

  /** Stop a sign-in in flight, or sign out of one source. */
  const disconnect = useCallback(
    async (source: "app" | "cli"): Promise<void> => {
      setDisconnecting(true);
      setError(null);
      try {
        apply(
          await fetchJson<GithubConnection>(`/api/integrations/github?source=${source}`, {
            method: "DELETE",
          }),
        );
      } catch (err) {
        console.error(`Failed to sign out of GitHub (${source}):`, err);
        setError(err instanceof Error ? err.message : "Failed to sign out of GitHub");
      } finally {
        setDisconnecting(false);
      }
    },
    [apply],
  );

  /** Drop a code nobody is going to approve, without signing anything out. */
  const cancel = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      apply(
        await fetchJson<GithubConnection>("/api/integrations/github?cancel=1", {
          method: "DELETE",
        }),
      );
    } catch (err) {
      console.error("Failed to cancel the GitHub sign-in:", err);
      setError(err instanceof Error ? err.message : "Failed to cancel the GitHub sign-in");
    }
  }, [apply]);

  /** The repository set of one installation, for the card's list. */
  const loadRepositories = useCallback(
    async (installationId: string): Promise<GithubRepositoriesAnswer> => {
      try {
        return {
          repositories: await fetchJson<GithubInstallationRepositories>(
            `/api/integrations/github/repositories?installation=${encodeURIComponent(installationId)}`,
          ),
          error: null,
        };
      } catch (err) {
        console.error("Failed to read the installation's repositories:", err);
        return {
          repositories: null,
          error: err instanceof Error ? err.message : "Failed to read the repositories",
        };
      }
    },
    [],
  );

  return {
    app,
    cli,
    loading,
    starting,
    disconnecting,
    error,
    load,
    connect,
    cancel,
    disconnect,
    loadRepositories,
  };
}
