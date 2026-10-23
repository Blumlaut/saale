import { genericOAuth } from "better-auth/plugins";
import { decodeJwt } from "jose";
import { getEnabledTelegramBot, type TelegramBotConfig } from "./bot";
import { getPublicUrl } from "@/lib/public-url";
import { buildLinkSuccessMessage, sendTelegramMessage } from "./client";
import { linkTelegramFromOidc } from "./links";
import { TELEGRAM_OIDC_PROVIDER_ID } from "./login";

export { TELEGRAM_OIDC_PROVIDER_ID };

/**
 * Telegram OpenID Connect. signing in with the same bot that serves the chat.
 *
 * Telegram has no plain OAuth, but it does publish an OIDC provider, and the
 * identity it hands back is the Telegram user id the Bot API also uses for
 * that account. That is the whole trick: a verified login and a bot message
 * are two proofs of the same thing, so both go through one link (see
 * `links.ts`) instead of two half-identities that never line up.
 *
 * The client id is the bot's own numeric id and the secret comes from the same
 * BotFather screen as the redirect URI, so an instance is configured once, in
 * `TELEGRAM_OIDC_CLIENT_ID` / `TELEGRAM_OIDC_CLIENT_SECRET` (see .env.example).
 */

const TELEGRAM_OIDC_DISCOVERY_URL = "https://oauth.telegram.org/.well-known/openid-configuration";

/**
 * `profile` is what carries the numeric user id (`openid` alone returns an
 * opaque `sub`), and `telegram:bot_access` is what lets the bot open the
 * conversation. without it a fresh login can read messages but never send
 * one until the user writes first.
 */
const TELEGRAM_OIDC_SCOPES = ["openid", "profile", "telegram:bot_access"];

/**
 * Placeholder address domain for accounts that only ever sign in with
 * Telegram. RFC 2606 reserves `.invalid` so it can never be routed, which is
 * the point: nothing is ever sent to it.
 */
const TELEGRAM_EMAIL_DOMAIN = "telegram.invalid";

interface TelegramOidcCredentials {
  clientId: string;
  clientSecret: string;
}

/** The deployed credentials, or null when this instance has not configured login. */
export function getTelegramOidcCredentials(): TelegramOidcCredentials | null {
  const clientId = (process.env.TELEGRAM_OIDC_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.TELEGRAM_OIDC_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Where Telegram sends the user back to.
 *
 * Must be registered verbatim in BotFather. an unregistered one makes
 * Telegram fall back to returning the authorization code in the URL fragment,
 * where the server never sees it.
 */
export function buildTelegramLoginRedirectUri(): string {
  return `${getPublicUrl()}/api/auth/callback/${TELEGRAM_OIDC_PROVIDER_ID}`;
}

/** Read a claim that may arrive as a string or a number. */
function claimText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Read an identity claim: Telegram user ids are always digits, and nothing else addresses a chat. */
function claimDigits(value: unknown): string | null {
  const text = claimText(value);
  if (!text || !/^\d+$/.test(text)) return null;
  return text.startsWith("0") ? String(BigInt(text)) : text;
}

/**
 * The Telegram user id behind an id_token's claims.
 *
 * `profile` attributes the numeric user id to `id` ("User ID"); `openid`
 * attributes an identifier to `sub`, which the same token can report
 * differently. Only the Bot API's numbering addresses a chat, so `id` wins and
 * `sub` is the fallback.
 */
export function telegramUserIdFromClaims(claims: Record<string, unknown>): string | null {
  const id = claimDigits(claims.id);
  const sub = claimDigits(claims.sub);
  if (id && sub && id !== sub) {
    console.warn("Telegram id_token id and sub claims differ; using id:", { id, sub });
  }
  return id ?? sub;
}

/** What to call the linked account in the UI: their Telegram name, else @handle. */
export function displayNameFromClaims(claims: Record<string, unknown>): string | null {
  return (
    claimText(claims.name) ?? claimText(claims.preferred_username) ?? claimText(claims.given_name)
  );
}

/** Claims of an id_token better-auth has already verified against Telegram's JWKS. */
function idTokenClaims(idToken: string): Record<string, unknown> | null {
  try {
    return decodeJwt(idToken) as Record<string, unknown>;
  } catch (err) {
    console.error("Failed to decode a Telegram id_token:", err);
    return null;
  }
}

/** A Telegram user id as the database stores it, or null when unusable. */
function toTelegramUserId(accountId: string): bigint | null {
  if (!/^\d+$/.test(accountId)) return null;
  try {
    return BigInt(accountId);
  } catch {
    return null;
  }
}

/**
 * The provider, registered only when the instance has credentials.
 *
 * Telegram has no userinfo endpoint: every claim arrives in the verified
 * id_token, which is why `getUserInfo` reads it rather than calling out.
 */
export function telegramOidcPlugins() {
  const credentials = getTelegramOidcCredentials();
  if (!credentials) return [];

  return [
    genericOAuth({
      config: [
        {
          providerId: TELEGRAM_OIDC_PROVIDER_ID,
          name: "Telegram",
          discoveryUrl: TELEGRAM_OIDC_DISCOVERY_URL,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          scopes: [...TELEGRAM_OIDC_SCOPES],
          // Identity is whatever the id_token says, so refuse to register the
          // provider unless discovery supplied an issuer and a JWKS to verify
          // it against.
          requireIdTokenVerification: true,
          // Signing in proves an account exists; it does not create one. The
          // register page asks with `requestSignUp`, and that is the only
          // place a Telegram account can come from.
          disableImplicitSignUp: true,
          // The account key is the Telegram user id, not the OAuth `sub`.
          accountSubject: ({ profile }) => telegramUserIdFromClaims(profile) ?? "",
          getUserInfo: async ({ idToken }) => {
            if (!idToken) {
              console.error("Telegram token response carried no id_token");
              return null;
            }
            const claims = idTokenClaims(idToken);
            const telegramUserId = claims ? telegramUserIdFromClaims(claims) : null;
            if (!claims || !telegramUserId) {
              console.error("Telegram id_token did not identify a user", {
                claims: claims ? Object.keys(claims) : null,
              });
              return null;
            }
            return {
              sub: telegramUserId,
              name: displayNameFromClaims(claims) ?? "Telegram user",
              image: claimText(claims.picture) ?? undefined,
              email: `${telegramUserId}@${TELEGRAM_EMAIL_DOMAIN}`,
              // Telegram never reports an email, and this address is invented,
              // so it must never pass a check that assumes a verified one.
              emailVerified: false,
            };
          },
        },
      ],
    }),
  ];
}

export interface TelegramLoginStatus {
  /** Credentials are present, so better-auth registers the provider at all. */
  configured: boolean;
  /** The client id this instance was deployed with. Telegram expects the bot's own id. */
  clientId: string | null;
  /** The id of the configured, enabled bot that serves the chat. Null when there is none. */
  botId: string | null;
  /** The bot's @username (without @), when one is configured and switched on. */
  botUsername: string | null;
  /** Login is usable: credentials present *and* naming the bot that serves the chat. */
  enabled: boolean;
  /** The URL to register as the redirect URI in BotFather. */
  redirectUri: string;
}

/**
 * Whether this instance can offer Telegram login.
 *
 * Credentials that name a bot other than the configured one are treated as off:
 * the login would still work, but the consent screen would show a bot that
 * never receives the user's messages.
 */
export async function getTelegramLoginStatus(): Promise<TelegramLoginStatus> {
  const credentials = getTelegramOidcCredentials();
  const bot = await getEnabledTelegramBot();
  const botId = bot?.botId != null ? String(bot.botId) : null;

  return {
    configured: credentials !== null,
    clientId: credentials?.clientId ?? null,
    botId,
    botUsername: bot?.botUsername ?? null,
    enabled: credentials !== null && botId !== null && botId === credentials.clientId,
    redirectUri: buildTelegramLoginRedirectUri(),
  };
}

/**
 * Say hello in the chat the new link points at.
 *
 * A login proves the Telegram account, not that the bot may write to it, so a
 * refused send (the account never started the bot and granted no bot access)
 * is an expected outcome and must not fail the login.
 */
async function greetLinkedChat(bot: TelegramBotConfig, chatId: bigint): Promise<void> {
  try {
    await sendTelegramMessage(bot.encryptedToken, chatId, buildLinkSuccessMessage(), {
      parseMode: "HTML",
    });
  } catch (err) {
    console.error(`Failed to greet the Telegram chat ${chatId} after linking:`, err);
  }
}

/**
 * Mirror a completed Telegram login into the link the bot routes messages by.
 *
 * Runs as the `account.create.after` hook: it is the moment a Saale user and a
 * Telegram identity first belong together, whichever of the two arrived
 * second. Everything after that. the bot answering a message, the agent
 * sending one. reads the link, not the session.
 */
export async function linkTelegramFromOidcLogin(account: {
  userId: string;
  providerId: string;
  accountId: string;
  idToken?: string | null | undefined;
}): Promise<void> {
  if (account.providerId !== TELEGRAM_OIDC_PROVIDER_ID) return;

  const telegramUserId = toTelegramUserId(account.accountId);
  if (!telegramUserId) {
    console.error(
      `Telegram login produced an unusable account id for user ${account.userId}:`,
      account.accountId,
    );
    return;
  }

  // A link hangs off the bot row, so without one there is nothing to point at.
  const bot = await getEnabledTelegramBot();
  if (!bot) {
    console.error(
      `Telegram login for user ${account.userId} has no enabled bot to link to (${telegramUserId})`,
    );
    return;
  }

  const claims = account.idToken ? idTokenClaims(account.idToken) : null;
  const result = await linkTelegramFromOidc({
    userId: account.userId,
    telegramUserId,
    displayName: claims ? displayNameFromClaims(claims) : null,
  });

  if (!result.ok) {
    console.error(
      `Failed to link Telegram ${telegramUserId} to user ${account.userId}: ${result.reason}`,
    );
    return;
  }

  await greetLinkedChat(bot, telegramUserId);
}
