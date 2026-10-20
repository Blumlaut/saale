import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { fetchOpenAIModels, buildGlobalModelRuntime } from "@/lib/pi/models";
import { providerCatalog, type ProviderCatalogView } from "@/lib/providers/catalog";
import { CUSTOM_PROVIDER_ID } from "@/lib/providers/config";
import { parseProviderLimits } from "@/lib/providers/limits";
import { detectAndStoreProviderCapabilities } from "@/lib/providers/provider-capabilities";

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
 * GET /api/admin/providers — every provider Pi can talk to, and which of them
 * the global configuration has credentials for.
 */
export async function GET() {
  const authResult = await requirePermission("admin", "providers");
  if (!authResult.ok) return authResult.response;

  const [rows, { modelRuntime }] = await Promise.all([
    prisma.providerApiKey.findMany({
      where: { userId: null },
      select: ROW_COLUMNS,
      orderBy: { provider: "asc" },
    }),
    buildGlobalModelRuntime(),
  ]);

  const configuredIds = new Set(rows.map((row) => row.provider));

  const availableProviders: ProviderCatalogView[] = providerCatalog(modelRuntime).map((entry) => {
    const status = entry.custom
      ? {
          configured: configuredIds.has(entry.id),
          source: configuredIds.has(entry.id) ? "stored" : null,
        }
      : (() => {
          const resolved = modelRuntime.getProviderAuthStatus(entry.id);
          return { configured: resolved.configured, source: resolved.source ?? null };
        })();

    return { ...entry, configured: status.configured, source: status.source, isGlobal: true };
  });

  return NextResponse.json({
    providers: rows.map((row) => ({
      ...row,
      displayName:
        availableProviders.find((entry) => entry.id === row.provider)?.name ?? row.provider,
    })),
    availableProviders,
  });
}

/**
 * POST /api/admin/providers — configure the *global* OpenAI-compatible endpoint.
 *
 * Every other provider is configured by signing in to it
 * (`POST /api/admin/providers/login`), because Pi owns how those providers
 * authenticate.
 */
export async function POST(request: NextRequest) {
  const authResult = await requirePermission("admin", "providers");
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { provider, apiKey, label, baseUrl } = body;

  if (provider !== CUSTOM_PROVIDER_ID) {
    return NextResponse.json(
      {
        error:
          "Only the OpenAI-compatible endpoint is configured here — sign in to a provider instead",
      },
      { status: 400 },
    );
  }

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

  const existing = await prisma.providerApiKey.findFirst({
    where: { userId: null, provider },
    select: { id: true },
  });

  const key = existing
    ? await prisma.providerApiKey.update({
        where: { id: existing.id },
        data: { encryptedKey, label: label || "", baseUrl, ...parsedLimits.limits },
      })
    : await prisma.providerApiKey.create({
        data: {
          userId: null,
          provider,
          encryptedKey,
          label: label || "",
          baseUrl,
          ...parsedLimits.limits,
        },
      });

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
    discoveredModels,
    modelCount: discoveredModels.length,
    visionModels,
  });
}

/**
 * PATCH /api/admin/providers — Update the global endpoint's model defaults
 * without touching its API key (so the UI never has to re-submit a stored
 * credential).
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requirePermission("admin", "providers");
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

  const existing = await prisma.providerApiKey.findFirst({
    where: { userId: null, provider },
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

/** DELETE /api/admin/providers — remove the global provider's credentials. */
export async function DELETE(request: NextRequest) {
  const authResult = await requirePermission("admin", "providers");
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider");

  if (!provider) {
    return NextResponse.json({ error: "provider query parameter is required" }, { status: 400 });
  }

  await prisma.providerApiKey.deleteMany({
    where: {
      userId: null,
      provider,
    },
  });

  return NextResponse.json({ success: true, provider });
}
