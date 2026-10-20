import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { buildModelRuntime } from "@/lib/pi/models";
import { providerCatalog, type ProviderCatalogView } from "@/lib/providers/catalog";
import { CUSTOM_PROVIDER_ID, definesProviderModels } from "@/lib/providers/config";
import { parseProviderLimits } from "@/lib/providers/limits";
import { detectAndStoreProviderCapabilities } from "@/lib/providers/provider-capabilities";
import { fetchOpenAIModels } from "@/lib/pi/models";

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

/**
 * GET /api/providers. every provider Pi can talk to, and what this user has
 * configured (their own credentials, and the global ones they inherit).
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const userId = authResult.user.id;

  const [userRows, globalRows, { modelRuntime }] = await Promise.all([
    prisma.providerApiKey.findMany({
      where: { userId },
      select: ROW_COLUMNS,
      orderBy: { provider: "asc" },
    }),
    prisma.providerApiKey.findMany({
      where: { userId: null },
      select: ROW_COLUMNS,
      orderBy: { provider: "asc" },
    }),
    buildModelRuntime(userId),
  ]);

  const ownRows = new Map(userRows.map((row) => [row.provider, row]));
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
      isGlobal: !ownRows.has(entry.id) && inheritedRows.has(entry.id),
    };
  });

  return NextResponse.json({
    // The caller's own rows. Saale's own endpoint is configured from one.
    // Which providers a user *inherits* is in `availableProviders.isGlobal`.
    providers: userRows.map((row) => ({
      ...row,
      displayName: displayName(availableProviders, row.provider),
    })),
    availableProviders,
  });
}

function displayName(providers: ProviderCatalogView[], provider: string): string {
  return providers.find((entry) => entry.id === provider)?.name ?? provider;
}

/**
 * POST /api/providers. configure Saale's own OpenAI-compatible endpoint.
 *
 * Every other provider is configured by signing in to it
 * (`POST /api/providers/login`), because Pi owns how those providers
 * authenticate: it decides which value to ask for, and how to resolve it.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { provider, apiKey, label, baseUrl } = body;

  if (provider !== CUSTOM_PROVIDER_ID) {
    return NextResponse.json(
      {
        error:
          "Only the OpenAI-compatible endpoint is configured here. sign in to a provider instead",
      },
      { status: 400 },
    );
  }

  // apiKey is optional for local servers
  if (apiKey && (typeof apiKey !== "string" || apiKey.length < 3)) {
    return NextResponse.json(
      { error: "API key must be at least 3 characters if provided" },
      { status: 400 },
    );
  }

  if (!baseUrl || typeof baseUrl !== "string" || baseUrl.length < 5) {
    return NextResponse.json(
      { error: "Base URL is required for OpenAI-compatible providers" },
      { status: 400 },
    );
  }

  const parsedLimits = parseProviderLimits(provider, body);
  if ("error" in parsedLimits) {
    return NextResponse.json({ error: parsedLimits.error }, { status: 400 });
  }

  const encryptedKey = encrypt(apiKey || "");

  const key = await prisma.providerApiKey.upsert({
    where: {
      userId_provider: {
        userId: authResult.user.id,
        provider,
      },
    },
    create: {
      userId: authResult.user.id,
      provider,
      encryptedKey,
      label: label || "",
      baseUrl,
      ...parsedLimits.limits,
    },
    update: {
      encryptedKey,
      label: label || "",
      baseUrl,
      ...parsedLimits.limits,
    },
  });

  // Importing the endpoint is where Saale learns its models, and asking what
  // they can do is how it learns that a local vision model accepts images.
  const discoveredModels = await fetchOpenAIModels(baseUrl, apiKey || undefined);
  let visionModels = 0;

  if (discoveredModels.length > 0) {
    const summary = await detectAndStoreProviderCapabilities({
      keyId: key.id,
      stored: key.modelCapabilities,
      baseUrl,
      apiKey: apiKey || undefined,
      modelIds: discoveredModels,
    });
    visionModels = summary.visionModels;
  }

  return NextResponse.json({
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
  });
}

/**
 * PATCH /api/providers. Update the endpoint's model limits without touching its
 * API key (so the UI never has to re-submit a stored credential).
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const provider = body.provider;

  if (provider !== CUSTOM_PROVIDER_ID) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }

  const parsedLimits = parseProviderLimits(provider, body);
  if ("error" in parsedLimits) {
    return NextResponse.json({ error: parsedLimits.error }, { status: 400 });
  }

  const existing = await prisma.providerApiKey.findUnique({
    where: {
      userId_provider: {
        userId: authResult.user.id,
        provider,
      },
    },
    select: { id: true },
  });

  if (!existing) {
    return NextResponse.json({ error: "Provider is not configured" }, { status: 404 });
  }

  const key = await prisma.providerApiKey.update({
    where: { id: existing.id },
    data: parsedLimits.limits,
  });

  return NextResponse.json({
    provider: key.provider,
    contextWindow: key.contextWindow,
    maxOutputTokens: key.maxOutputTokens,
  });
}

/**
 * DELETE /api/providers. Disconnect a provider.
 *
 * The row *is* the credential for a provider Pi authenticates (Saale's
 * credential store reads it), so removing it signs the provider out.
 */
export async function DELETE(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider");

  if (!provider) {
    return NextResponse.json({ error: "provider query parameter is required" }, { status: 400 });
  }

  await prisma.providerApiKey.deleteMany({
    where: {
      userId: authResult.user.id,
      provider,
    },
  });

  return NextResponse.json({ success: true, provider });
}
