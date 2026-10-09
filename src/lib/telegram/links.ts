import { createHash, randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { TELEGRAM_BOT_ID } from "./bot";

/**
 * Linking a Telegram account to a Saale user.
 *
 * The link is the *only* thing that maps an incoming Telegram message to a
 * Saale account, so it is deliberately narrow: one Telegram identity per Saale
 * user (`userId` unique) and one Saale user per Telegram identity
 * (`telegramUserId` unique). Nothing carried by a message can widen it — a
 * sender either matches a link or is refused.
 *
 * A link is established from the Saale side, never from Telegram:
 * `issueLinkCode` runs in an authenticated session and hands back a one-time
 * secret that only that user ever sees; `consumeLinkCode` redeems it. Shoulder-
 * surfing the bot therefore proves control of the Telegram account, not of a
 * Saale account, and cannot move the binding to a different user.
 */

/** How long a link code stays usable. Long enough to switch apps, short enough to leak safely. */
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Plaintext link codes are 32 base64url characters (192 bits). The alphabet is
 * exactly what Telegram allows in a `/start` deep-link payload, so the code can
 * travel either as a tappable link or as `/start <code>` typed on another device.
 */
const LINK_CODE_BYTES = 24;
export const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export interface TelegramLinkInfo {
  id: string;
  userId: string;
  telegramUserId: bigint;
  telegramChatId: bigint;
  displayName: string | null;
  sessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Hash a link code for storage. Codes are high-entropy, so a plain digest is enough. */
export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Why a link code could not be redeemed. */
export type ConsumeLinkCodeFailure =
  /** Unknown, already used, or past its expiry. */
  | "expired"
  /** The sending Telegram account is already linked to a different Saale user. */
  | "already_linked";

export type ConsumeLinkCodeResult =
  { ok: true; link: TelegramLinkInfo } | { ok: false; reason: ConsumeLinkCodeFailure };

/** Internal signal used to roll the redemption transaction back. */
class LinkCodeRejected extends Error {
  constructor(readonly reason: ConsumeLinkCodeFailure) {
    super(reason);
    this.name = "LinkCodeRejected";
  }
}

/**
 * Mint a single-use link code for a user.
 *
 * The plaintext is returned once and never stored — only its hash is, so a
 * database read cannot be turned into a working link.
 */
export async function issueLinkCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(LINK_CODE_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);

  // Drop this user's leftovers first so the table cannot accumulate them, and
  // a second "Link" press cannot leave two live codes.
  await prisma.telegramLinkCode.deleteMany({ where: { userId } }).catch((err) => {
    console.error(`Failed to clear stale Telegram link codes for ${userId}:`, err);
  });

  await prisma.telegramLinkCode.create({
    data: { codeHash: hashLinkCode(code), userId, expiresAt },
  });

  return { code, expiresAt };
}

/**
 * Redeem a link code sent to the bot, binding the sender's Telegram account.
 *
 * The code — not the message — decides which Saale user is linked, which is
 * what keeps a shared bot from being a shared account.
 */
export async function consumeLinkCode(params: {
  code: string;
  telegramUserId: bigint;
  telegramChatId: bigint;
  displayName: string | null;
}): Promise<ConsumeLinkCodeResult> {
  const { code, telegramUserId, telegramChatId, displayName } = params;
  const codeHash = hashLinkCode(code);
  const now = new Date();

  try {
    const link = await prisma.$transaction(async (tx) => {
      // Claiming the row *is* the single-use check: deleting by the unique hash
      // means a concurrent `/start` with the same code loses the race with a
      // P2025 rather than both of them linking.
      const claim = await tx.telegramLinkCode
        .delete({ where: { codeHash } })
        .catch((err: unknown) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
            throw new LinkCodeRejected("expired");
          }
          throw err;
        });

      if (claim.expiresAt <= now) throw new LinkCodeRejected("expired");

      const existing = await tx.telegramLink.findUnique({ where: { telegramUserId } });
      if (existing && existing.userId !== claim.userId) {
        // Deliberately not a takeover: silently re-pointing the link would hand
        // this Telegram account someone else's Saale data on a forwarded code.
        throw new LinkCodeRejected("already_linked");
      }

      // One Telegram identity per user: re-linking replaces this user's own
      // previous account (the user is authenticated, so this is their choice).
      await tx.telegramLink.deleteMany({ where: { userId: claim.userId } });

      return tx.telegramLink.create({
        data: {
          botId: TELEGRAM_BOT_ID,
          userId: claim.userId,
          telegramUserId,
          telegramChatId,
          displayName,
        },
      });
    });

    return { ok: true, link };
  } catch (err) {
    if (err instanceof LinkCodeRejected) return { ok: false, reason: err.reason };
    throw err;
  }
}

/** A user's link, or null when they have not linked a Telegram account. */
export async function getLinkByUserId(userId: string): Promise<TelegramLinkInfo | null> {
  return prisma.telegramLink.findUnique({ where: { userId } });
}

/**
 * The link owned by a Telegram identity.
 *
 * This is the lookup every inbound path starts from, so an unlinked sender
 * resolves to null and is refused — there is no fallback to another account.
 */
export async function getLinkByTelegramUserId(
  telegramUserId: bigint,
): Promise<TelegramLinkInfo | null> {
  return prisma.telegramLink.findUnique({ where: { telegramUserId } });
}

/**
 * Remove a user's link and any code they still hold.
 *
 * The linked chat is kept on the bot's side; nothing is sent to Telegram, so
 * unlinking is silent — which is what someone revoking access usually wants.
 */
export async function unlinkUser(userId: string): Promise<boolean> {
  const [, removed] = await prisma.$transaction([
    prisma.telegramLinkCode.deleteMany({ where: { userId } }),
    prisma.telegramLink.deleteMany({ where: { userId } }),
  ]);

  return removed.count > 0;
}

/** Cache the sender's Telegram name against their link (fire-and-forget from the webhook). */
export async function updateLinkDisplayName(
  telegramUserId: bigint,
  displayName: string | null,
): Promise<void> {
  await prisma.telegramLink.updateMany({
    where: { telegramUserId },
    data: { displayName },
  });
}

/** Point a link at the Saale chat session it is currently talking through. */
export async function setLinkSession(userId: string, sessionId: string): Promise<void> {
  await prisma.telegramLink.update({ where: { userId }, data: { sessionId } });
}
