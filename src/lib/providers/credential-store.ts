/**
 * Pi's credential storage, backed by Saale's database.
 *
 * Pi owns the auth semantics for every provider it knows: its `login()` flows
 * collect whatever a provider needs (an API key, extra account values, OAuth
 * tokens), `resolve()` turns the stored credential into request auth, and OAuth
 * tokens are refreshed through the store, under a per-provider lock. Saale
 * supplies the storage and never decides what a credential contains, so adding
 * a provider to Pi adds it to Saale unchanged.
 *
 * A credential is stored as one encrypted JSON blob (`encryptedCredential`).
 * Rows written before this existed hold a bare API key (`encryptedKey`, still
 * used by Saale's own OpenAI-compatible endpoint), and are read as an
 * api-key credential so an existing key keeps working.
 *
 * Scope: a user reads their own credential and otherwise inherits the global
 * (admin) one; writes always land in the writer's own scope.
 */

import type {
  ApiKeyCredential,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { z } from "zod";

import { decrypt, encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";

/** Which of Saale's two credential scopes a runtime reads and writes. */
export type ProviderScope = { kind: "user"; userId: string } | { kind: "global" };

const apiKeyCredentialSchema = z.object({
  type: z.literal("api_key"),
  key: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * OAuth credentials carry provider-defined extras (an issued client id, a
 * Copilot token, …) that Pi reads back after a refresh, so unknown keys must
 * survive a round trip.
 */
const oauthCredentialSchema = z.looseObject({
  type: z.literal("oauth"),
  refresh: z.string(),
  access: z.string(),
  expires: z.number(),
});

const credentialSchema = z.union([apiKeyCredentialSchema, oauthCredentialSchema]);

/** Parse a stored credential. Malformed input is reported and treated as absent. */
export function parseCredential(value: unknown, context: string): Credential | undefined {
  const parsed = credentialSchema.safeParse(value);
  if (!parsed.success) {
    console.error(`Stored credential for ${context} is malformed; treating it as absent.`);
    return undefined;
  }
  const credential = parsed.data;
  if (credential.type === "api_key") {
    const apiKey: ApiKeyCredential = { type: "api_key" };
    if (credential.key !== undefined) apiKey.key = credential.key;
    if (credential.env !== undefined) apiKey.env = credential.env;
    return apiKey;
  }
  const oauth: OAuthCredential = {
    ...credential,
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
  };
  return oauth;
}

/** The credential columns of a `provider_api_key` row. */
interface CredentialRow {
  provider: string;
  encryptedKey: string;
  encryptedCredential: string | null;
}

const CREDENTIAL_COLUMNS = {
  provider: true,
  encryptedKey: true,
  encryptedCredential: true,
} as const;

/** The `userId` column value for a scope (null = the global configuration). */
function scopeUserId(scope: ProviderScope): string | null {
  return scope.kind === "global" ? null : scope.userId;
}

/** Decrypt one row into a credential. Never throws — a broken row reads as absent. */
function decodeCredential(row: CredentialRow): Credential | undefined {
  const context = `provider ${row.provider}`;

  if (row.encryptedCredential) {
    try {
      return parseCredential(JSON.parse(decrypt(row.encryptedCredential)), context);
    } catch (err) {
      console.error(`Failed to decrypt the credential for ${context}:`, err);
      return undefined;
    }
  }

  try {
    const key = decrypt(row.encryptedKey);
    return key ? { type: "api_key", key } : undefined;
  } catch (err) {
    console.error(`Failed to decrypt the API key for ${context}:`, err);
    return undefined;
  }
}

/**
 * The Pi credential store for one scope.
 *
 * Reads are served from a per-instance snapshot of the scope's rows — building
 * a model runtime asks for a credential once per provider, and that must not
 * become a query per provider. Writes go through `modify`/`delete` (the only
 * mutation paths Pi uses), which keep the snapshot in step.
 *
 * Writes are serialized per provider in-process, matching Pi's own store. Two
 * Saale processes could still interleave a write; the row is written in full
 * each time, so the loser of a race stores one complete credential, never a
 * blend.
 */
export function createProviderCredentialStore(scope: ProviderScope): CredentialStore {
  const userId = scopeUserId(scope);
  /** provider id → credential, loaded once per instance (undefined value = absent). */
  let snapshot: Map<string, Credential | undefined> | null = null;
  const chains = new Map<string, Promise<void>>();

  /** Run `task` after any in-flight operation for the same provider. */
  function enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(providerId) ?? Promise.resolve();
    const queued = (async () => {
      await previous.catch(() => undefined);
      return task();
    })();
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    chains.set(providerId, tail);
    void tail.then(() => {
      if (chains.get(providerId) === tail) chains.delete(providerId);
    });
    return queued;
  }

  async function loadRows(): Promise<CredentialRow[]> {
    const own = await prisma.providerApiKey.findMany({
      where: { userId },
      select: CREDENTIAL_COLUMNS,
    });
    // A user inherits the global configuration for providers they have not
    // configured themselves.
    if (userId === null) return own;

    const ownProviders = new Set(own.map((row) => row.provider));
    const global = await prisma.providerApiKey.findMany({
      where: { userId: null },
      select: CREDENTIAL_COLUMNS,
    });
    return [...own, ...global.filter((row) => !ownProviders.has(row.provider))];
  }

  async function loadSnapshot() {
    if (snapshot) return snapshot;
    const rows = await loadRows();
    snapshot = new Map(rows.map((row) => [row.provider, decodeCredential(row)]));
    return snapshot;
  }

  /**
   * Store one credential, in the writer's own scope.
   *
   * The global scope has no compound-unique lookup (Prisma models `userId` as a
   * plain string there), so it reads the single row by its columns first.
   */
  async function writeCredential(providerId: string, credential: Credential) {
    const encryptedCredential = encrypt(JSON.stringify(credential));

    if (userId === null) {
      const existing = await prisma.providerApiKey.findFirst({
        where: { userId: null, provider: providerId },
        select: { id: true },
      });
      await (existing
        ? prisma.providerApiKey.update({
            where: { id: existing.id },
            data: { encryptedCredential },
          })
        : prisma.providerApiKey.create({
            data: {
              userId: null,
              provider: providerId,
              encryptedKey: encrypt(""),
              encryptedCredential,
            },
          }));
      return;
    }

    await prisma.providerApiKey.upsert({
      where: { userId_provider: { userId, provider: providerId } },
      create: {
        userId,
        provider: providerId,
        encryptedKey: encrypt(""),
        encryptedCredential,
      },
      update: { encryptedCredential },
    });
  }

  return {
    async read(providerId) {
      const credentials = await loadSnapshot();
      return credentials.get(providerId);
    },

    async list() {
      const credentials = await loadSnapshot();
      const entries: CredentialInfo[] = [];
      for (const [providerId, credential] of credentials) {
        if (credential) entries.push({ providerId, type: credential.type });
      }
      return entries;
    },

    modify(providerId, fn) {
      return enqueue(providerId, async () => {
        const credentials = await loadSnapshot();
        const current = credentials.get(providerId);
        const next = await fn(current);
        // `undefined` leaves the entry unchanged (Pi's contract).
        if (next === undefined) return current;

        await writeCredential(providerId, next);
        credentials.set(providerId, next);
        return next;
      });
    },

    delete(providerId) {
      return enqueue(providerId, async () => {
        await prisma.providerApiKey.deleteMany({ where: { userId, provider: providerId } });
        (await loadSnapshot()).delete(providerId);
      });
    },
  };
}
