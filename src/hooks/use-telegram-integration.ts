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
 *
 * @param initialAccount - Optional initial account data to avoid a redundant fetch
 *                         when the parent has already loaded it.
 */
export function useTelegramIntegration(initialAccount?: TelegramAccount | null) {
  // Account state
  const [account, setAccount] = useState<TelegramAccount | null>(initialAccount ?? null);
  const [loading, setLoading] = useState(!initialAccount);
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
    } catch (err) {
      console.error("Failed to load Telegram account:", err);
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
    } catch (err) {
      console.error("Failed to load Telegram whitelist:", err);
      setWhitelistEntries([]);
    } finally {
      setWhitelistLoading(false);
    }
  }, []);

  // Only fetch if no initial data was provided
  useEffect(() => {
    if (!initialAccount) {
      loadAccount();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        const message = (err as Error).message || "Failed to save Telegram bot";
        console.error("Failed to save Telegram token:", err);
        setTokenError(message);
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
      } catch (err) {
        console.error("Failed to toggle Telegram integration:", err);
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
    } catch (err) {
      console.error("Failed to add Telegram whitelist user:", err);
    } finally {
      setAddingUser(false);
    }
  }, [newUserId, loadWhitelist]);

  const removeWhitelistUser = useCallback(
    async (id: string) => {
      try {
        await fetchJson(`/api/integrations/telegram/whitelist/${id}`, { method: "DELETE" });
        await loadWhitelist();
      } catch (err) {
        console.error("Failed to remove Telegram whitelist user:", err);
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
