"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson, postJson, putJson } from "@/lib/http";
import type { GithubStatus } from "@/lib/integrations/github";

/** What the card needs of one GitHub source. */
export interface GithubAppSection {
  configured: boolean;
  /** The app's slug, for the install link GitHub hosts. */
  slug: string | null;
  /** The app's display name. */
  name: string | null;
  /** The permissions the app was registered with. */
  permissions: Record<string, string> | null;
  authorized: { login: string; expiresAt: string | null } | null;
  installations: {
    installationId: string;
    accountLogin: string;
    accountType: string;
    repositorySelection: string;
    repositories: string[] | null;
    suspended: boolean;
  }[];
  pending: { userCode: string; verificationUri: string; expiresAt: string } | null;
}

/** Both sources as the API reports them, and the errors a call can raise. */
interface GithubConnection {
  app: GithubAppSection;
  cli: GithubStatus;
}

/** One installation's repository set, as the picker shows it. */
export interface GithubRepositoryChoices {
  installationId: string;
  accountLogin: string;
  selection: string;
  /** False when the installation covers every repository; GitHub then refuses. */
  canManage: boolean;
  installed: { id: string; name: string; fullName: string }[];
  candidates: { id: string; fullName: string; installed: boolean }[];
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

  /** The repository set of one installation, for the picker. */
  const loadRepositories = useCallback(
    async (installationId: string): Promise<GithubRepositoryChoices | null> => {
      try {
        return await fetchJson<GithubRepositoryChoices>(
          `/api/integrations/github/repositories?installation=${encodeURIComponent(installationId)}`,
        );
      } catch (err) {
        console.error("Failed to read the installation's repositories:", err);
        setError(err instanceof Error ? err.message : "Failed to read the repositories");
        return null;
      }
    },
    [],
  );

  /** Apply a selection; the installation is what changes, not only a token. */
  const saveRepositories = useCallback(
    async (
      installationId: string,
      repositoryIds: readonly string[],
    ): Promise<GithubRepositoryChoices | null> => {
      try {
        return await putJson<GithubRepositoryChoices>("/api/integrations/github/repositories", {
          installationId,
          repositoryIds: [...repositoryIds],
        });
      } catch (err) {
        console.error("Failed to change the installation's repositories:", err);
        setError(err instanceof Error ? err.message : "Failed to change the repositories");
        return null;
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
    saveRepositories,
  };
}
