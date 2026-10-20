/**
 * Council → sandbox identity.
 *
 * A council's file tools must not reach the user's home. Unix permissions give
 * that for free: Open Terminal's multi-user mode maps each `X-User-Id` to its
 * own Linux account whose home is `chmod 2770`, so the account owning a
 * *council's* workspace is a different account from the user's. neither can
 * read the other. A council therefore gets a synthetic identity of its own
 * instead of borrowing the user's:
 *
 *   council → `sandboxKey` (8 hex chars) → `X-User-Id` → Linux account + home
 *
 * The key must be **unique instance-wide**, not per user: it names a Linux
 * account in one shared container, and two councils sharing an account would
 * share a workspace. It is derived from the council and user ids, so it is
 * stable for a council and uncorrelated with anything a user chose.
 */

import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import {
  deriveOpenTerminalUsername,
  getTerminalHomeDir,
  isConfigured,
} from "@/lib/terminal/client";
import { SANDBOX_KEY_LENGTH } from "./config";
import { containerAccountExists } from "./commands";

/**
 * The key for one council, at a given attempt.
 *
 * Open Terminal builds a Linux username from the **first 8** alphanumeric
 * characters of the id it is handed, so the key is generated at exactly that
 * length. a longer key would be silently truncated, and two keys sharing their
 * first eight characters would be one account. Domain-separated from every
 * other hash in the app, and salted per attempt so a collision can step aside
 * deterministically instead of failing.
 */
export function deriveSandboxKey(councilId: string, userId: string, attempt = 0): string {
  return crypto
    .createHash("sha256")
    .update(`saale-council-sandbox:v1:${userId}:${councilId}:${attempt}`)
    .digest("hex")
    .slice(0, SANDBOX_KEY_LENGTH);
}

export interface CouncilSandboxIdentity {
  /** The synthetic `X-User-Id` and stored `Council.sandboxKey`. */
  key: string;
  /** The Linux account the container maps it to. */
  account: string;
  /** That account's home directory. the sandbox root. */
  home: string;
}

export function sandboxIdentity(key: string): CouncilSandboxIdentity {
  return { key, account: deriveOpenTerminalUsername(key), home: getTerminalHomeDir(key) };
}

/** How many salted attempts to make before giving the key up as unusable. */
const KEY_ATTEMPTS = 16;

/**
 * Pick a free sandbox key for a council that is being created.
 *
 * Two things can already own the derived account, and both are checked:
 * - another council (its key is stored), and
 * - an existing Linux account. the user's own, or one left behind by
 *   something else in the container. which `getent` reports.
 *
 * The council keys are read instance-wide on purpose. This is the one place
 * that must be true globally rather than per user: the key names a Linux account
 * in a container shared by every tenant, so the query cannot be scoped to
 * `userId` without dropping the guarantee. Only the keys themselves are read
 * eight random hex characters with no user data attached.
 *
 * With no container configured there is no sandbox at all, so only the stored
 * keys matter and the uniqueness constraint on `Council.sandboxKey` backs it up.
 */
export async function allocateSandboxKey(userId: string, councilId: string): Promise<string> {
  const taken = new Set(
    (await prisma.council.findMany({ select: { sandboxKey: true } })).map((row) => row.sandboxKey),
  );

  for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt += 1) {
    const key = deriveSandboxKey(councilId, userId, attempt);
    if (taken.has(key)) continue;
    if (isConfigured() && (await containerAccountExists(sandboxIdentity(key).account))) continue;
    return key;
  }

  throw new Error(`No free council sandbox key for council ${councilId} after ${KEY_ATTEMPTS}`);
}
