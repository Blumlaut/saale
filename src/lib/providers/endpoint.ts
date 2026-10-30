/**
 * Reading the rows that describe a credential scope's OpenAI-compatible
 * endpoints.
 *
 * A scope can run several: each is its own provider (`custom-<slug>`), a user
 * sees the endpoints they linked plus the ones an admin linked globally, and
 * their own row for an id wins over the global one. An admin's local endpoint is
 * usable by everyone, and its models must be pickable for everyone.
 *
 * Server-only: it reads the database and decrypts the stored key.
 */

import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { CUSTOM_PROVIDER_LABEL, isEndpointProvider } from "@/lib/providers/config";
import type { ProviderScope } from "@/lib/providers/credential-store";

/** The columns of an endpoint row that describe it and its models. */
const ENDPOINT_COLUMNS = {
  id: true,
  userId: true,
  provider: true,
  label: true,
  baseUrl: true,
  encryptedKey: true,
  contextWindow: true,
  maxOutputTokens: true,
  modelCapabilities: true,
} as const;

export interface EndpointRow {
  id: string;
  /** null for a global (admin) endpoint. */
  userId: string | null;
  provider: string;
  label: string;
  baseUrl: string | null;
  encryptedKey: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  modelCapabilities: unknown;
}

/** What a row goes by in the UI. */
export function endpointName(row: Pick<EndpointRow, "label">): string {
  return row.label.trim() || CUSTOM_PROVIDER_LABEL;
}

/** Every endpoint the scope can use, its own rows first. */
export async function readEndpointRows(scope: ProviderScope): Promise<EndpointRow[]> {
  const userId = scope.kind === "global" ? null : scope.userId;

  const own = await prisma.providerApiKey.findMany({
    where: { userId },
    select: ENDPOINT_COLUMNS,
    orderBy: { createdAt: "asc" },
  });
  const ownEndpoints = own.filter((row) => isEndpointProvider(row.provider));
  if (scope.kind === "global") return ownEndpoints;

  const global = await prisma.providerApiKey.findMany({
    where: { userId: null },
    select: ENDPOINT_COLUMNS,
    orderBy: { createdAt: "asc" },
  });
  const ownProviders = new Set(ownEndpoints.map((row) => row.provider));

  return [
    ...ownEndpoints,
    ...global.filter((row) => isEndpointProvider(row.provider) && !ownProviders.has(row.provider)),
  ];
}

/** One endpoint of the scope by its provider id, or `null`. */
export async function readEndpointRow(
  scope: ProviderScope,
  provider: string,
): Promise<EndpointRow | null> {
  const rows = await readEndpointRows(scope);
  return rows.find((row) => row.provider === provider) ?? null;
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
