import { decrypt } from "@/lib/crypto";
import type { TelegramBotConfig } from "./bot";
import { validateBotToken } from "./client";

/**
 * What the configured bot looks like in Telegram.
 *
 * `getMe` is the only place the display name exists; the row keeps the id and
 * the handle, both of which a token can outlive. A failed read is remembered
 * briefly so a page load cannot stall on an unreachable Telegram.
 */
export interface TelegramBotProfile {
  firstName: string;
  username: string | null;
  avatarUrl: string | null;
}

/** Renames in BotFather are rare enough that five minutes of the old name costs nothing. */
const PROFILE_TTL_MS = 5 * 60_000;

/** An unreachable Telegram is retried at most once a minute. */
const PROFILE_RETRY_MS = 60_000;

/** Telegram serves a public profile picture here, and answers 404 when the bot has none. */
function avatarUrlFor(username: string | null): string | null {
  return username ? `https://t.me/i/userpic/320/${encodeURIComponent(username)}.jpg` : null;
}

let cached: { key: string; readAt: number; profile: TelegramBotProfile | null } | null = null;

/** The configured bot's own name, handle and picture, or null when Telegram does not answer. */
export async function readTelegramBotProfile(
  bot: TelegramBotConfig,
): Promise<TelegramBotProfile | null> {
  // A new token is a new bot until proven otherwise, so the cache follows the row.
  const key = `${bot.id}:${bot.updatedAt.getTime()}`;
  if (cached?.key === key) {
    const age = Date.now() - cached.readAt;
    const ttl = cached.profile ? PROFILE_TTL_MS : PROFILE_RETRY_MS;
    if (age < ttl) return cached.profile;
  }

  try {
    const info = await validateBotToken(decrypt(bot.encryptedToken));
    const profile: TelegramBotProfile = {
      firstName: info.botFirstName,
      username: info.botUsername,
      avatarUrl: avatarUrlFor(info.botUsername),
    };
    cached = { key, readAt: Date.now(), profile };
    return profile;
  } catch (err) {
    console.error("Failed to read the Telegram bot profile:", err);
    cached = { key, readAt: Date.now(), profile: null };
    return null;
  }
}
