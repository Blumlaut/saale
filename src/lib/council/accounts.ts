/**
 * Council → sandbox identity.
 *
 * A council's file tools must not reach the owner's workspace, and the owner
 * must not read the council's. The boundary is a directory in the workspaces
 * volume plus the container that mounts only that directory: a council gets a
 * synthetic identity of its own rather than borrowing the user's.
 *
 *   council → `sandboxKey` (8 hex chars) → `council-<key>` directory of the volume
 *
 * The key must be **unique instance-wide**, not per user: it names a directory
 * in one shared volume, and two councils sharing it would share a workspace. It
 * is derived from the council and user ids, so it is stable for a council and
 * uncorrelated with anything a user chose.
 */

import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { councilIdentity, isSandboxIdentity } from "@/lib/sandbox/identity";
import { identityPath } from "@/lib/sandbox/workspace";
import { SANDBOX_KEY_LENGTH } from "./config";

/**
 * The key for one council, at a given attempt.
 *
 * Eight characters because that is the length the stored key has always had and
 * a directory name of that size stays readable. Domain-separated from every
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
  /** The stored `Council.sandboxKey`. */
  key: string;
  /** The workspace identity: `council-<key>`. */
  id: string;
  /** That identity's directory in the volume. the sandbox root. */
  path: string;
}

export function sandboxIdentity(key: string): CouncilSandboxIdentity {
  const id = councilIdentity(key);
  return { key, id, path: identityPath(id) };
}

/** How many salted attempts to make before giving the key up as unusable. */
const KEY_ATTEMPTS = 16;

/**
 * Pick a free sandbox key for a council that is being created.
 *
 * The council keys are read instance-wide on purpose. This is the one place
 * that must be true globally rather than per user: the key names a directory in
 * a volume shared by every tenant, so the query cannot be scoped to `userId`
 * without dropping the guarantee. Only the keys themselves are read. eight
 * random hex characters with no user data attached.
 *
 * Keys of deleted councils are in scope too: their directories may still be
 * there, and reusing one would hand a new council another council's files.
 */
export async function allocateSandboxKey(userId: string, councilId: string): Promise<string> {
  const taken = new Set(
    (await prisma.council.findMany({ select: { sandboxKey: true } })).map((row) => row.sandboxKey),
  );

  for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt += 1) {
    const key = deriveSandboxKey(councilId, userId, attempt);
    if (taken.has(key)) continue;
    if (!isSandboxIdentity(councilIdentity(key))) continue;
    return key;
  }

  throw new Error(`No free council sandbox key for council ${councilId} after ${KEY_ATTEMPTS}`);
}
