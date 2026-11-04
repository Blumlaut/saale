/**
 * Sign-in failures, counted against the account rather than the address.
 *
 * better-auth's own limit counts requests per client address, and that address
 * arrives in `x-forwarded-for`, which the caller writes itself. Rotating the
 * header hands an attacker a fresh bucket per guess, so the count that makes
 * guessing cost something is kept on the account the attempt names.
 *
 * Only refusals are counted, and the counter expires: a mistyped password costs
 * nothing once the window has passed.
 */

import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { normalizeUsername } from "@/lib/auth/username";

/** A count from the environment, or the default when it is not one. */
function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Refused attempts one account may make inside the window. */
export const SIGN_IN_FAILURE_LIMIT = positiveInteger(process.env.SIGN_IN_FAILURE_LIMIT, 10);

/** How long a refusal counts, in seconds. */
export const SIGN_IN_FAILURE_WINDOW_SECONDS = positiveInteger(
  process.env.SIGN_IN_FAILURE_WINDOW_SECONDS,
  900,
);

/** The endpoints that check a password, and the field each carries its handle in. */
const HANDLE_FIELD_BY_PATH = {
  "/sign-in/email": "email",
  "/sign-in/username": "username",
} as const;

/** What a locked account is told. */
export const SIGN_IN_LOCKED_ERROR = {
  code: "TOO_MANY_ATTEMPTS",
  message: "Too many failed sign-in attempts. Try again later.",
} as const;

const KEY_PREFIX = "auth:sign-in-failures:";

/** The account handle a sign-in request names. */
export interface SignInHandle {
  field: "email" | "username";
  value: string;
}

/** The handle a sign-in request names, or null when it is not a sign-in. */
export function signInHandle(path: string | undefined, body: unknown): SignInHandle | null {
  const field = HANDLE_FIELD_BY_PATH[path as keyof typeof HANDLE_FIELD_BY_PATH];
  if (!field) return null;

  const raw = (body as Record<string, unknown> | null | undefined)?.[field];
  if (typeof raw !== "string") return null;

  const value = field === "email" ? raw.trim().toLowerCase() : normalizeUsername(raw);
  return value ? { field, value } : null;
}

/**
 * The bucket an attempt is counted in. The account when the handle names one,
 * so a wrong password against an email and against that account's username add
 * up rather than each buying a budget of its own.
 */
async function failureKey(handle: SignInHandle): Promise<string> {
  const user = await prisma.user.findFirst({
    where:
      handle.field === "email"
        ? { email: { equals: handle.value, mode: "insensitive" } }
        : { username: handle.value },
    select: { id: true },
  });

  if (user) return `${KEY_PREFIX}user:${user.id}`;

  // No account behind the handle. The handle is its own bucket, so guesses at
  // one address still add up, and nothing here tells the caller whether the
  // account exists.
  const digest = createHash("sha256").update(`${handle.field}:${handle.value}`).digest("hex");
  return `${KEY_PREFIX}handle:${digest.slice(0, 32)}`;
}

/** Whether this account has spent its attempts. */
export async function isSignInLockedOut(handle: SignInHandle): Promise<boolean> {
  try {
    const stored = await getRedis().get(await failureKey(handle));
    return Number(stored ?? 0) >= SIGN_IN_FAILURE_LIMIT;
  } catch (err) {
    // A rate limit that fails closed would lock every account out with Redis.
    console.error("Failed to read the sign-in failure count:", err);
    return false;
  }
}

/** Count one failed attempt, and start the window with the first. */
export async function recordSignInFailure(handle: SignInHandle): Promise<void> {
  try {
    const redis = getRedis();
    const key = await failureKey(handle);
    if ((await redis.incr(key)) === 1) await redis.expire(key, SIGN_IN_FAILURE_WINDOW_SECONDS);
  } catch (err) {
    console.error("Failed to record a sign-in failure:", err);
  }
}

/** Whether a sign-in's response was a refusal. */
function isRefused(returned: unknown): boolean {
  return (
    returned instanceof APIError ||
    (typeof returned === "object" &&
      returned !== null &&
      (returned as { name?: unknown }).name === "APIError")
  );
}

/** Count the attempt when the sign-in was refused. */
export async function recordRefusedSignIn(
  path: string | undefined,
  body: unknown,
  returned: unknown,
): Promise<void> {
  if (!isRefused(returned)) return;

  const handle = signInHandle(path, body);
  if (handle) await recordSignInFailure(handle);
}
