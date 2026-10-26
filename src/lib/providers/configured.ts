/**
 * Configured provider rows behind `/api/providers` and `/api/admin/providers`.
 * The two routes differ in whose credentials they read and which model runtime
 * they build, so the owner is the only argument.
 */

import { decrypt, encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { buildGlobalModelRuntime, buildModelRuntime, fetchOpenAIModels } from "@/lib/pi/models";
import { providerCatalog, type ProviderCatalogView } from "@/lib/providers/catalog";
import { CUSTOM_PROVIDER_ID, definesProviderModels } from "@/lib/providers/config";
import { parseProviderLimits } from "@/lib/providers/limits";
import {
  detectAndStoreProviderCapabilities,
  parseModelSettingsEdit,
  rejectUnconfigurableProvider,
  setProviderModelSettings,
} from "@/lib/providers/provider-capabilities";

/** Whose credentials a call reads and writes. `null` is the global config. */
export interface ProviderOwner {
  userId: string | null;
}

/** The columns the provider UI needs from a configured row. */
const ROW_COLUMNS = {
  id: true,
  provider: true,
  label: true,
  baseUrl: true,
  contextWindow: true,
  maxOutputTokens: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface ConfiguredProviderList {
  providers: Array<{
    id: string;
    provider: string;
    label: string;
    baseUrl: string | null;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    createdAt: Date;
    updatedAt: Date;
    displayName: string;
  }>;
  availableProviders: ProviderCatalogView[];
}

/** What a write did, or the message and status the route should answer with. */
export type ProviderWriteOutcome =
  { ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: string };

/** The body a configure call carries. Model limits come through the same object. */
export interface ConfiguredProviderBody {
  provider?: unknown;
  apiKey?: unknown;
  label?: unknown;
  baseUrl?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
}

/** Every provider Pi can talk to, and what this owner has configured for it. */
export async function listConfiguredProviders(
  owner: ProviderOwner,
): Promise<ConfiguredProviderList> {
  const global = owner.userId === null;

  const [rows, globalRows, { modelRuntime }] = await Promise.all([
    prisma.providerApiKey.findMany({
      where: { userId: owner.userId },
      select: ROW_COLUMNS,
      orderBy: { provider: "asc" },
    }),
    global
      ? Promise.resolve([])
      : prisma.providerApiKey.findMany({
          where: { userId: null },
          select: ROW_COLUMNS,
          orderBy: { provider: "asc" },
        }),
    global ? buildGlobalModelRuntime() : buildModelRuntime(owner.userId as string),
  ]);

  const ownRows = new Map(rows.map((row) => [row.provider, row]));
  const inheritedRows = new Map(
    globalRows.filter((row) => !ownRows.has(row.provider)).map((row) => [row.provider, row]),
  );
  const rowFor = (provider: string) => ownRows.get(provider) ?? inheritedRows.get(provider);

  const availableProviders: ProviderCatalogView[] = providerCatalog(modelRuntime).map((entry) => {
    const row = rowFor(entry.id);
    // Saale's own endpoint is configured by its row, not by Pi's auth state: a
    // local server needs no key, and an empty key still resolves.
    const status = entry.custom
      ? {
          configured: row !== undefined,
          source: row ? (ownRows.has(entry.id) ? "stored" : "global") : null,
        }
      : (() => {
          const resolved = modelRuntime.getProviderAuthStatus(entry.id);
          return { configured: resolved.configured, source: resolved.source ?? null };
        })();

    return {
      ...entry,
      configured: status.configured,
      source: status.source,
      // An admin's own rows are the global configuration.
      isGlobal: global || (!ownRows.has(entry.id) && inheritedRows.has(entry.id)),
    };
  });

  return {
    providers: rows.map((row) => ({
      ...row,
      displayName:
        availableProviders.find((entry) => entry.id === row.provider)?.name ?? row.provider,
    })),
    availableProviders,
  };
}

/**
 * Store the owner's OpenAI-compatible endpoint and learn its models.
 *
 * Asking the endpoint what it serves is where Saale learns the models, and
 * which of them accept images.
 */
export async function saveCustomEndpoint(
  owner: ProviderOwner,
  body: ConfiguredProviderBody,
): Promise<ProviderWriteOutcome> {
  const { provider, apiKey, label, baseUrl } = body;

  if (provider !== CUSTOM_PROVIDER_ID) {
    return {
      ok: false,
      status: 400,
      error:
        "Only the OpenAI-compatible endpoint is configured here. sign in to a provider instead",
    };
  }

  // apiKey is optional for local servers
  if (apiKey && (typeof apiKey !== "string" || apiKey.length < 3)) {
    return { ok: false, status: 400, error: "API key must be at least 3 characters if provided" };
  }

  if (!baseUrl || typeof baseUrl !== "string" || baseUrl.length < 5) {
    return {
      ok: false,
      status: 400,
      error: "Base URL is required for OpenAI-compatible providers",
    };
  }

  const parsedLimits = parseProviderLimits(provider, body);
  if ("error" in parsedLimits) {
    return { ok: false, status: 400, error: parsedLimits.error };
  }

  const secret = typeof apiKey === "string" ? apiKey : "";
  const fields = {
    encryptedKey: encrypt(secret),
    label: typeof label === "string" ? label : "",
    baseUrl,
    ...parsedLimits.limits,
  };

  let key;
  if (owner.userId) {
    key = await prisma.providerApiKey.upsert({
      where: { userId_provider: { userId: owner.userId, provider } },
      create: { userId: owner.userId, provider, ...fields },
      update: fields,
    });
  } else {
    const existing = await findRow(owner, provider);
    key = existing
      ? await prisma.providerApiKey.update({ where: { id: existing.id }, data: fields })
      : await prisma.providerApiKey.create({ data: { userId: null, provider, ...fields } });
  }

  const discoveredModels = await fetchOpenAIModels(baseUrl, secret || undefined);
  let visionModels = 0;

  if (discoveredModels.length > 0) {
    const summary = await detectAndStoreProviderCapabilities({
      keyId: key.id,
      stored: key.modelCapabilities,
      baseUrl,
      apiKey: secret || undefined,
      modelIds: discoveredModels,
    });
    visionModels = summary.visionModels;
  }

  return {
    ok: true,
    data: {
      provider: key.provider,
      label: key.label,
      baseUrl: key.baseUrl,
      contextWindow: key.contextWindow,
      maxOutputTokens: key.maxOutputTokens,
      configured: true,
      displayName: definesProviderModels(provider) ? "OpenAI-compatible" : provider,
      discoveredModels,
      modelCount: discoveredModels.length,
      visionModels,
    },
  };
}

/** Update the endpoint's model limits without touching its API key. */
export async function saveCustomEndpointLimits(
  owner: ProviderOwner,
  body: ConfiguredProviderBody,
): Promise<ProviderWriteOutcome> {
  const provider = body.provider;

  if (provider !== CUSTOM_PROVIDER_ID) {
    return { ok: false, status: 400, error: "provider is required" };
  }

  const parsedLimits = parseProviderLimits(provider, body);
  if ("error" in parsedLimits) {
    return { ok: false, status: 400, error: parsedLimits.error };
  }

  const existing = await findRow(owner, provider);
  if (!existing) {
    return { ok: false, status: 404, error: "Provider is not configured" };
  }

  const key = await prisma.providerApiKey.update({
    where: { id: existing.id },
    data: parsedLimits.limits,
  });

  return {
    ok: true,
    data: {
      provider: key.provider,
      contextWindow: key.contextWindow,
      maxOutputTokens: key.maxOutputTokens,
    },
  };
}

/**
 * Disconnect a provider.
 *
 * The row *is* the credential for a provider Pi authenticates (Saale's
 * credential store reads it), so removing it signs the provider out.
 */
export async function deleteConfiguredProvider(
  owner: ProviderOwner,
  provider: string | null,
): Promise<ProviderWriteOutcome> {
  if (!provider) {
    return { ok: false, status: 400, error: "provider query parameter is required" };
  }

  await prisma.providerApiKey.deleteMany({
    where: { userId: owner.userId, provider },
  });

  return { ok: true, data: { success: true, provider } };
}

/** The owner's row for a provider. A global row has no compound key to address. */
function findRow(owner: ProviderOwner, provider: string) {
  return owner.userId
    ? prisma.providerApiKey.findUnique({
        where: { userId_provider: { userId: owner.userId, provider } },
        select: { id: true },
      })
    : prisma.providerApiKey.findFirst({
        where: { userId: null, provider },
        select: { id: true },
      });
}

/** The key columns the capability routes read, and nothing else. */
const KEY_COLUMNS = {
  id: true,
  provider: true,
  baseUrl: true,
  encryptedKey: true,
  modelCapabilities: true,
} as const;

/** The owner's row for a provider, or the global one for the admin. */
function findProviderKey(owner: ProviderOwner, provider: string) {
  return owner.userId
    ? prisma.providerApiKey.findUnique({
        where: { userId_provider: { userId: owner.userId, provider } },
        select: KEY_COLUMNS,
      })
    : prisma.providerApiKey.findFirst({
        where: { userId: null, provider },
        select: KEY_COLUMNS,
      });
}

/**
 * Record what one of the owner's models can do and how big its window is.
 *
 * A key the body omits is left as stored, and `null` clears it, so the model
 * inherits the endpoint's default again.
 */
export async function saveModelCapabilities(
  owner: ProviderOwner,
  body: ConfiguredProviderBody & { modelId?: unknown },
): Promise<ProviderWriteOutcome> {
  const providerError = rejectUnconfigurableProvider(body.provider);
  if (providerError) return { ok: false, status: 400, error: providerError };

  const edit = parseModelSettingsEdit(body);
  if ("error" in edit) return { ok: false, status: 400, error: edit.error };

  const key = await findProviderKey(owner, String(body.provider));
  if (!key) return { ok: false, status: 404, error: "Provider is not configured" };

  const modelCapabilities = await setProviderModelSettings({
    keyId: key.id,
    stored: key.modelCapabilities,
    edit,
  });

  return { ok: true, data: { provider: key.provider, modelCapabilities } };
}

/**
 * Ask the owner's endpoint what its models can do and store the answers.
 *
 * The probe reads the stored base URL, never one from the request: the route
 * must not become a way to make the server call an arbitrary host.
 */
export async function detectModelCapabilities(
  owner: ProviderOwner,
  body: ConfiguredProviderBody,
): Promise<ProviderWriteOutcome> {
  const providerError = rejectUnconfigurableProvider(body.provider);
  if (providerError) return { ok: false, status: 400, error: providerError };

  const key = await findProviderKey(owner, String(body.provider));
  if (!key) return { ok: false, status: 404, error: "Provider is not configured" };
  if (!key.baseUrl) {
    return { ok: false, status: 400, error: "Provider has no base URL to probe" };
  }

  const summary = await detectAndStoreProviderCapabilities({
    keyId: key.id,
    stored: key.modelCapabilities,
    baseUrl: key.baseUrl,
    apiKey: decrypt(key.encryptedKey) || undefined,
  });

  return { ok: true, data: { provider: key.provider, ...summary } };
}
