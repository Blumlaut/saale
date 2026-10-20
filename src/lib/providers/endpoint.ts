/**
 * Reading the row that describes a credential scope's OpenAI-compatible
 * endpoint.
 *
 * One endpoint per scope: a user's own row wins, otherwise they inherit the
 * global one, exactly as they inherit a provider credential — an admin's local
 * endpoint is usable by everyone, and its models must be pickable for everyone.
 *
 * Server-only: it reads the database and decrypts the stored key.
 */

import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { CUSTOM_PROVIDER_ID, CUSTOM_PROVIDER_LABEL } from "@/lib/providers/config";
import type { ProviderScope } from "@/lib/providers/credential-store";

/** The columns of an endpoint row that describe its models. */
const ENDPOINT_COLUMNS = {
  id: true,
  userId: true,
  baseUrl: true,
  encryptedKey: true,
  contextWindow: true,
  maxOutputTokens: true,
  modelCapabilities: true,
} as const;

export interface EndpointRow {
  id: string;
  /** null for the global (admin) endpoint. */
  userId: string | null;
  baseUrl: string | null;
  encryptedKey: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  modelCapabilities: unknown;
}

/** The scope's endpoint row, or `null` when it has not configured one. */
export async function readEndpointRow(scope: ProviderScope): Promise<EndpointRow | null> {
  if (scope.kind === "user") {
    const own = await prisma.providerApiKey.findUnique({
      where: { userId_provider: { userId: scope.userId, provider: CUSTOM_PROVIDER_ID } },
      select: ENDPOINT_COLUMNS,
    });
    if (own) return own;
  }

  // The global scope has no compound-unique lookup (Prisma types
  // `userId_provider.userId` as non-null), so it reads the row by its columns.
  return prisma.providerApiKey.findFirst({
    where: { userId: null, provider: CUSTOM_PROVIDER_ID },
    select: ENDPOINT_COLUMNS,
  });
}

/**
 * The endpoint's API key, decrypted.
 *
 * A key that cannot be decrypted still leaves the endpoint usable (a local
 * server needs none), so it is reported and treated as absent.
 */
export function endpointApiKey(row: EndpointRow): string | undefined {
  try {
    return decrypt(row.encryptedKey) || undefined;
  } catch (err) {
    console.error(`Failed to decrypt the ${CUSTOM_PROVIDER_LABEL} API key:`, err);
    return undefined;
  }
}
