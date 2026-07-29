"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchJson, postJson, patchJson } from "@/lib/http";

export interface GitHubAccount {
  id: string;
  enabled: boolean;
  username: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Self-contained hook for GitHub integration state and actions.
 */
export function useGitHubIntegration() {
  // Account state
  const [account, setAccount] = useState<GitHubAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Token form
  const [token, setToken] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSuccess, setTokenSuccess] = useState(false);

  const loadAccount = useCallback(async () => {
    try {
      const data = await fetchJson<{ account: GitHubAccount | null }>("/api/integrations/github");
      setAccount(data.account);
    } catch {
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  // Reset token form
  const resetTokenForm = useCallback(() => {
    setToken("");
    setTokenError(null);
    setTokenSuccess(false);
  }, []);

  // ─── Actions ────────────────────────────────────────────────────────

  const saveToken = useCallback(
    async (onSuccess?: () => void) => {
      if (!token.trim()) {
        setTokenError("Personal Access Token is required");
        return;
      }

      setSavingToken(true);
      setTokenError(null);
      setTokenSuccess(false);

      try {
        await postJson("/api/integrations/github", { token: token.trim() });
        setTokenSuccess(true);
        await loadAccount();
        onSuccess?.();
      } catch (err) {
        setTokenError((err as Error).message || "Failed to connect GitHub");
      } finally {
        setSavingToken(false);
      }
    },
    [token, loadAccount],
  );

  const toggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (!account) return;
      setActionLoading("toggle");
      try {
        await patchJson("/api/integrations/github", { enabled });
        await loadAccount();
      } catch {
        // Ignore
      } finally {
        setActionLoading(null);
      }
    },
    [account, loadAccount],
  );

  return {
    // Account
    account,
    loading,
    actionLoading,
    loadAccount,

    // Token form
    token,
    setToken,
    savingToken,
    tokenError,
    tokenSuccess,
    resetTokenForm,
    saveToken,

    // Enable/disable
    toggleEnabled,
  };
}
