/**
 * Pairing a desktop agent with this instance.
 *
 * The user reads a one-time code off the settings page and pastes it into the
 * agent, which trades it for a bearer token. Only the code's hash is stored, so
 * a database read cannot be turned into a pairing, and the code is claimed by
 * deleting it, so two agents cannot both redeem it.
 */

import { createHash, randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { readDeviceGroups, sanitizeDeviceName, type DeviceGroup } from "./shared";
import { hashDeviceToken, mintDeviceToken } from "./tokens";

/** How long a code stays usable. Long enough to read it and walk to the machine. */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

/** No 0/O/1/I: the code is read off one screen and typed into another. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const CODE_LENGTH = 8;

/** A code in the form the settings page shows it. */
function randomPairCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  // The alphabet is 32 characters, so a byte maps onto it without bias.
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Fold what the user or the agent typed into the form the hash is taken of. */
export function normalizePairCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/(.{4})(?=.)/g, "$1-");
}

function hashPairCode(code: string): string {
  return createHash("sha256").update(normalizePairCode(code)).digest("hex");
}

/** Mint a single-use code for a user, replacing any they minted before. */
export async function issuePairCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
  const code = randomPairCode();
  const expiresAt = new Date(Date.now() + PAIR_CODE_TTL_MS);

  await prisma.devicePairCode.deleteMany({ where: { userId } }).catch((err) => {
    console.error(`Failed to clear stale device pair codes for ${userId}:`, err);
  });

  await prisma.devicePairCode.create({
    data: { codeHash: hashPairCode(code), userId, expiresAt },
  });

  return { code, expiresAt };
}

export interface RedeemPairCodeInput {
  code: string;
  /** What the agent calls itself. Its hostname, usually. */
  name: string;
  platform: string;
  session: string;
  capabilities: DeviceGroup[] | unknown;
  agentVersion: string;
}

export type RedeemPairCodeResult =
  | { ok: true; deviceId: string; name: string; token: string }
  | { ok: false; reason: "invalid" | "expired" };

/**
 * Trade a code for a token, and register the device.
 *
 * A machine that pairs again keeps its label and rotates its token: the old row
 * is replaced, so the previous install cannot keep connecting.
 */
export async function redeemPairCode(input: RedeemPairCodeInput): Promise<RedeemPairCodeResult> {
  const codeHash = hashPairCode(input.code);
  const name = sanitizeDeviceName(input.name);
  const token = mintDeviceToken();
  const now = new Date();

  try {
    const device = await prisma.$transaction(async (tx) => {
      // Claiming the row *is* the single-use check: a concurrent redeem of the
      // same code loses with P2025 instead of both creating a device.
      const claim = await tx.devicePairCode
        .delete({ where: { codeHash } })
        .catch((err: unknown) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
            throw new PairRejected("invalid");
          }
          throw err;
        });

      if (claim.expiresAt <= now) throw new PairRejected("expired");

      await tx.device.deleteMany({ where: { userId: claim.userId, name } });

      return tx.device.create({
        data: {
          userId: claim.userId,
          name,
          platform: input.platform.slice(0, 16) || "linux",
          session: input.session.slice(0, 16) || "unknown",
          tokenHash: hashDeviceToken(token),
          capabilities: readDeviceGroups(input.capabilities),
          agentVersion: input.agentVersion.slice(0, 40),
          lastSeenAt: now,
        },
      });
    });

    return { ok: true, deviceId: device.id, name: device.name, token };
  } catch (err) {
    if (err instanceof PairRejected) return { ok: false, reason: err.reason };
    throw err;
  }
}

class PairRejected extends Error {
  constructor(readonly reason: "invalid" | "expired") {
    super(`pair code ${reason}`);
  }
}
