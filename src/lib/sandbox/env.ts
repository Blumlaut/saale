/**
 * Per-user environment variables for an identity's commands.
 *
 * A user's rows are the only source: nothing from the app's own environment is
 * forwarded, so `DATABASE_URL`, `ENCRYPTION_KEY` and `SANDBOX_API_KEY` stay
 * where they are. Values are decrypted once per exec, passed to the service,
 * and never stored on a session, a prompt or a log line.
 *
 * Every read and write here filters `userId`. A background job resolves from
 * `task.userId` and a council from its owner's, so the same function cannot
 * reach another user's values.
 */

import { decrypt, encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { evictUserSessions } from "@/lib/pi/agent-pool";

/** `GH_TOKEN`, `NPM_CONFIG_TOKEN`: a shell-safe name, never a path or a command. */
const NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Variables one identity may carry. */
export const MAX_ENV_VARS = 32;

/** Total plaintext bytes across an identity's variables. */
export const MAX_ENV_TOTAL_BYTES = 32 * 1024;

/** Raised for a name or value the API refuses to store. */
export class SandboxEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxEnvError";
  }
}

export function isValidEnvName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** The name, or a throw. */
export function requireEnvName(name: unknown): string {
  if (typeof name !== "string" || !isValidEnvName(name)) {
    throw new SandboxEnvError(
      "Variable names start with a letter or underscore and hold A-Z, 0-9 or _ (max 64 characters).",
    );
  }
  return name;
}

/** Refuse a value that would not survive a single environment entry. */
export function requireEnvValue(value: unknown): string {
  if (typeof value !== "string") throw new SandboxEnvError("A variable value must be text");
  if (value.includes("\0")) throw new SandboxEnvError("A variable value cannot contain a NUL byte");
  if (Buffer.byteLength(value, "utf8") > MAX_ENV_TOTAL_BYTES) {
    throw new SandboxEnvError(`A variable value cannot exceed ${MAX_ENV_TOTAL_BYTES} bytes`);
  }
  return value;
}

/** Names only. what the API returns and the prompt lists. */
export async function listSandboxEnvNames(userId: string): Promise<string[]> {
  const rows = await prisma.sandboxEnvVar.findMany({
    where: { userId },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((row) => row.name);
}

/**
 * The variables for one exec.
 *
 * A row that will not decrypt is skipped and logged: one bad value must not
 * take every command down with it.
 */
export async function resolveSandboxEnv(userId: string): Promise<Record<string, string>> {
  const rows = await prisma.sandboxEnvVar.findMany({
    where: { userId },
    select: { name: true, encryptedValue: true },
  });

  const env: Record<string, string> = {};
  for (const row of rows) {
    try {
      env[row.name] = decrypt(row.encryptedValue);
    } catch (err) {
      console.error(`Failed to decrypt sandbox variable ${row.name} for ${userId}:`, err);
    }
  }
  return env;
}

/**
 * One variable's value, for a command that needs a single credential.
 *
 * A row that will not decrypt is null, like a value that was never set.
 */
export async function resolveSandboxEnvVar(userId: string, name: string): Promise<string | null> {
  const row = await prisma.sandboxEnvVar
    .findUnique({ where: { userId_name: { userId, name } }, select: { encryptedValue: true } })
    .catch((err: unknown) => {
      console.error(`Failed to read sandbox variable ${name} for ${userId}:`, err);
      return null;
    });
  if (!row) return null;

  try {
    return decrypt(row.encryptedValue);
  } catch (err) {
    console.error(`Failed to decrypt sandbox variable ${name} for ${userId}:`, err);
    return null;
  }
}

async function assertBudget(userId: string, extra: Record<string, string>): Promise<void> {
  const rows = await prisma.sandboxEnvVar.findMany({
    where: { userId },
    select: { name: true, encryptedValue: true },
  });
  const replaced = rows.filter((row) => row.name in extra).length;
  if (rows.length - replaced + Object.keys(extra).length > MAX_ENV_VARS) {
    throw new SandboxEnvError(`At most ${MAX_ENV_VARS} variables are allowed`);
  }

  let total = 0;
  for (const row of rows) {
    if (row.name in extra) continue;
    try {
      total += Buffer.byteLength(decrypt(row.encryptedValue), "utf8");
    } catch (err) {
      console.error(`Failed to decrypt sandbox variable ${row.name} while checking its size:`, err);
    }
  }
  for (const value of Object.values(extra)) total += Buffer.byteLength(value, "utf8");
  if (total > MAX_ENV_TOTAL_BYTES) {
    throw new SandboxEnvError(`Variables cannot exceed ${MAX_ENV_TOTAL_BYTES} bytes in total`);
  }
}

/**
 * Store a value and rebuild the user's pooled sessions, so the next prompt
 * names the new variable.
 */
export async function setSandboxEnvVar(userId: string, name: string, value: string): Promise<void> {
  const key = requireEnvName(name);
  const plaintext = requireEnvValue(value);
  await assertBudget(userId, { [key]: plaintext });

  await prisma.sandboxEnvVar.upsert({
    where: { userId_name: { userId, name: key } },
    create: { userId, name: key, encryptedValue: encrypt(plaintext) },
    update: { encryptedValue: encrypt(plaintext) },
  });

  await evictUserSessions(userId);
}

/** Remove a variable and rebuild the user's pooled sessions. */
export async function deleteSandboxEnvVar(userId: string, name: string): Promise<boolean> {
  const key = requireEnvName(name);
  const { count } = await prisma.sandboxEnvVar.deleteMany({ where: { userId, name: key } });
  if (count > 0) await evictUserSessions(userId);
  return count > 0;
}
