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
 * (`telegramUserId` unique). Nothing carried by a message can widen it. a
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

/** Why a Telegram identity could not be linked. */
export type LinkFailure =
  /** Unknown, already used, or past its expiry. */
  | "expired"
  /** The sending Telegram account is already linked to a different Saale user. */
  | "already_linked";

/** The reasons a link code can be refused (the code-less paths never expire). */
export type ConsumeLinkCodeFailure = LinkFailure;

export type ConsumeLinkCodeResult =
  { ok: true; link: TelegramLinkInfo } | { ok: false; reason: ConsumeLinkCodeFailure };

export type LinkTelegramResult =
  { ok: true; link: TelegramLinkInfo } | { ok: false; reason: LinkFailure };

/** Internal signal used to roll the link-writing transaction back. */
class LinkRejected extends Error {
  constructor(readonly reason: LinkFailure) {
    super(reason);
    this.name = "LinkRejected";
  }
}

/**
 * Write the link itself, inside the caller's transaction.
 *
 * Every way a Telegram identity can become bound to a Saale user goes through
 * here, so the two rules that keep a shared bot from being a shared account
 * hold everywhere: an identity another user already holds is never re-pointed,
 * and a user's own previous link is replaced rather than duplicated
 * (`userId` and `telegramUserId` are both unique).
 */
async function bindLink(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    telegramUserId: bigint;
    telegramChatId: bigint;
    displayName: string | null;
  },
): Promise<TelegramLinkInfo> {
  const existing = await tx.telegramLink.findUnique({
    where: { telegramUserId: params.telegramUserId },
  });
  if (existing && existing.userId !== params.userId) throw new LinkRejected("already_linked");

  await tx.telegramLink.deleteMany({ where: { userId: params.userId } });

  return tx.telegramLink.create({
    data: {
      botId: TELEGRAM_BOT_ID,
      userId: params.userId,
      telegramUserId: params.telegramUserId,
      telegramChatId: params.telegramChatId,
      displayName: params.displayName,
    },
  });
}

/**
 * Mint a single-use link code for a user.
 *
 * The plaintext is returned once and never stored. only its hash is, so a
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
 * The code. not the message. decides which Saale user is linked, which is
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
            throw new LinkRejected("expired");
          }
          throw err;
        });

      if (claim.expiresAt <= now) throw new LinkRejected("expired");

      return bindLink(tx, {
        userId: claim.userId,
        telegramUserId,
        telegramChatId,
        displayName,
      });
    });

    return { ok: true, link };
  } catch (err) {
    if (err instanceof LinkRejected) return { ok: false, reason: err.reason };
    throw err;
  }
}

/**
 * Bind a Telegram identity a login proved control of.
 *
 * Telegram's OpenID Connect flow proves the same thing a redeemed link code
 * does. control of that Telegram account. so it writes the same link, which
 * is what lets a login be used from either side: link once in Settings and you
 * can sign in with Telegram, sign in with Telegram and the bot already talks to
 * your account.
 *
 * The chat id is the user id: OAuth carries no message to read a chat from, and
 * a private chat with a user is addressed by that user's id.
 */
export async function linkTelegramFromOidc(params: {
  userId: string;
  telegramUserId: bigint;
  displayName: string | null;
}): Promise<LinkTelegramResult> {
  const { userId, telegramUserId, displayName } = params;

  try {
    const link = await prisma.$transaction((tx) =>
      bindLink(tx, { userId, telegramUserId, telegramChatId: telegramUserId, displayName }),
    );
    return { ok: true, link };
  } catch (err) {
    if (err instanceof LinkRejected) return { ok: false, reason: err.reason };
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
 * resolves to null and is refused. there is no fallback to another account.
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
 * unlinking is silent. which is what someone revoking access usually wants.
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
