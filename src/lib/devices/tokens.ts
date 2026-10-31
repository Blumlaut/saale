/**
 * Bearer tokens for a paired desktop agent.
 *
 * The token is minted once, handed to the agent at pairing and never stored:
 * the database keeps a sha256 of it. A database read therefore cannot be turned
 * into a working agent connection, and revoking is deleting the row.
 */

import { createHash, randomBytes } from "crypto";

/** Prefix on every agent token, so one found in a log is recognisable. */
export const DEVICE_TOKEN_PREFIX = "saale_dev_";

const TOKEN_BYTES = 32;

/** A fresh token for a device. Shown to the agent once, at pairing. */
export function mintDeviceToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** The lookup value for a token. What the `Device` row stores. */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Whether a string looks like one of our tokens, before it is hashed. */
export function isDeviceToken(value: string): boolean {
  return value.startsWith(DEVICE_TOKEN_PREFIX) && value.length > DEVICE_TOKEN_PREFIX.length;
}
