"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchJson, postJson, patchJson } from "@/lib/http";

export interface TelegramAccount {
  id: string;
  enabled: boolean;
  botId: string | null;
  botUsername: string | null;
  whitelistCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WhitelistEntry {
  id: string;
  telegramUserId: string;
  displayName: string | null;
  createdAt: string;
}

/**
 * Self-contained hook for Telegram integration state and actions.
 *
 * Encapsulates: account loading, token save, enable/disable,
 * whitelist CRUD. The calling component doesn't need to know about
 * Telegram's internal state.
 */
export function useTelegramIntegration() {
  // Account state
  const [account, setAccount] = useState<TelegramAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Token form
  const [token, setToken] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSuccess, setTokenSuccess] = useState(false);

  // Whitelist
  const [whitelistEntries, setWhitelistEntries] = useState<WhitelistEntry[]>([]);
  const [whitelistLoading, setWhitelistLoading] = useState(false);
  const [newUserId, setNewUserId] = useState("");
  const [addingUser, setAddingUser] = useState(false);

  const loadAccount = useCallback(async () => {
    try {
      const data = await fetchJson<{ account: TelegramAccount | null }>(
        "/api/integrations/telegram",
      );
      setAccount(data.account);
    } catch {
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWhitelist = useCallback(async () => {
    setWhitelistLoading(true);
    try {
      const data = await fetchJson<{ entries: WhitelistEntry[] }>(
        "/api/integrations/telegram/whitelist",
      );
      setWhitelistEntries(data.entries);
    } catch {
      setWhitelistEntries([]);
    } finally {
      setWhitelistLoading(false);
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

  // Reset whitelist form
  const resetWhitelistForm = useCallback(() => {
    setNewUserId("");
  }, []);

  // ─── Actions ────────────────────────────────────────────────────────

  const saveToken = useCallback(
    async (onSuccess?: () => void) => {
      if (!token.trim()) {
        setTokenError("Bot token is required");
        return;
      }

      setSavingToken(true);
      setTokenError(null);
      setTokenSuccess(false);

      try {
        await postJson("/api/integrations/telegram", { token: token.trim() });
        setTokenSuccess(true);
        await loadAccount();
        onSuccess?.();
      } catch (err) {
        setTokenError((err as Error).message || "Failed to save Telegram bot");
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
        await patchJson("/api/integrations/telegram", { enabled });
        await loadAccount();
      } catch {
        // Ignore
      } finally {
        setActionLoading(null);
      }
    },
    [account, loadAccount],
  );

  const addWhitelistUser = useCallback(async () => {
    if (!newUserId.trim()) return;

    setAddingUser(true);
    try {
      await postJson("/api/integrations/telegram/whitelist", {
        telegramUserId: newUserId.trim(),
      });
      setNewUserId("");
      await loadWhitelist();
    } catch {
      // Ignore — duplicate or error
    } finally {
      setAddingUser(false);
    }
  }, [newUserId, loadWhitelist]);

  const removeWhitelistUser = useCallback(
    async (id: string) => {
      try {
        await fetchJson(`/api/integrations/telegram/whitelist/${id}`, { method: "DELETE" });
        await loadWhitelist();
      } catch {
        // Ignore
      }
    },
    [loadWhitelist],
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

    // Whitelist
    whitelistEntries,
    whitelistLoading,
    newUserId,
    setNewUserId,
    addingUser,
    resetWhitelistForm,
    loadWhitelist,
    addWhitelistUser,
    removeWhitelistUser,
  };
}
