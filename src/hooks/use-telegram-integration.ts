"use client";

import { useState, useEffect, useCallback } from "react";
import { deleteJson, fetchJson, postJson } from "@/lib/http";

/** The instance's shared bot, as a user may see it. */
export interface TelegramBotStatus {
  configured: boolean;
  enabled: boolean;
  /** Bot @username (without the @), when known. */
  username: string | null;
  /** Whether this instance also offers signing in with the linked account. */
  loginEnabled: boolean;
}

/** This user's linked Telegram account. */
export interface TelegramLink {
  /** Telegram user ID (may exceed JS safe integers, so it travels as a string). */
  telegramUserId: string;
  chatId: string;
  displayName: string | null;
  linkedAt: string;
}

export interface TelegramIntegration {
  bot: TelegramBotStatus;
  link: TelegramLink | null;
}

/** A freshly minted one-time link code and where to redeem it. */
export interface TelegramLinkCode {
  code: string;
  deepLink: string;
  expiresAt: string;
  botUsername: string;
}

const NOT_CONFIGURED: TelegramIntegration = {
  bot: { configured: false, enabled: false, username: null, loginEnabled: false },
  link: null,
};

/**
 * Self-contained hook for the Telegram integration's state and actions.
 *
 * There is no token to manage any more: the bot belongs to the instance, so
 * this only covers whether one exists and whether *this* user has linked an
 * account to it.
 *
 * @param initial - Optional initial data, to skip the first fetch when the
 *                  parent has already loaded it.
 */
export function useTelegramIntegration() {
  const [integration, setIntegration] = useState<TelegramIntegration>(NOT_CONFIGURED);
  const [loading, setLoading] = useState(true);

  // Linking
  const [linkCode, setLinkCode] = useState<TelegramLinkCode | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Unlinking
  const [unlinking, setUnlinking] = useState(false);

  const loadIntegration = useCallback(async () => {
    try {
      const data = await fetchJson<{ integration: TelegramIntegration }>(
        "/api/integrations/telegram",
      );
      setIntegration(data.integration);
    } catch (err) {
      console.error("Failed to load the Telegram integration:", err);
      setIntegration(NOT_CONFIGURED);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadIntegration();
  }, [loadIntegration]);

  /** Clear the code panel (dialog closed, or the user started over). */
  const resetLinkCode = useCallback(() => {
    setLinkCode(null);
    setLinkError(null);
  }, []);

  /**
   * Mint a one-time code to link this account.
   *
   * The code is bound to this Saale user on the server, so redeeming it in
   * Telegram can only ever link this user's own Telegram account.
   */
  const createLinkCode = useCallback(async () => {
    setLinking(true);
    setLinkError(null);
    try {
      const data = await postJson<TelegramLinkCode>("/api/integrations/telegram", {});
      setLinkCode(data);
      await loadIntegration();
    } catch (err) {
      console.error("Failed to create a Telegram link code:", err);
      setLinkError((err as Error).message || "Failed to create a link code");
    } finally {
      setLinking(false);
    }
  }, [loadIntegration]);

  const unlink = useCallback(async () => {
    setUnlinking(true);
    try {
      await deleteJson("/api/integrations/telegram");
      setLinkCode(null);
      await loadIntegration();
    } catch (err) {
      console.error("Failed to unlink the Telegram account:", err);
    } finally {
      setUnlinking(false);
    }
  }, [loadIntegration]);

  return {
    integration,
    loading,
    link: integration.link,
    bot: integration.bot,
    loadIntegration,

    linkCode,
    linking,
    linkError,
    createLinkCode,
    resetLinkCode,

    unlinking,
    unlink,
  };
}
