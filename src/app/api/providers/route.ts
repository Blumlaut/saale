import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { PROVIDERS, definesProviderModels } from "@/lib/providers/config";
import { parseProviderLimits } from "@/lib/providers/limits";
import { detectAndStoreProviderCapabilities } from "@/lib/providers/provider-capabilities";

/**
 * Fetch models from an OpenAI-compatible /models endpoint.
 */
async function fetchOpenAIModels(
  baseUrl: string,
  apiKey?: string,
): Promise<{ models: string[]; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return {
        models: [],
        error: `HTTP ${res.status} from ${url}`,
      };
    }

    const data = await res.json();
    if (!data?.data?.length) {
      return {
        models: [],
        error: "No models returned by server",
      };
    }

    return {
      models: data.data.map((m: { id: string }) => m.id).slice(0, 200),
    };
  } catch (err) {
    return {
      models: [],
      error: `${(err as Error).message} (checking ${url})`,
    };
  }
}

/**
 * GET /api/providers — List user's configured providers (user-scoped only).
 * Also returns global providers so the UI can show inherited access.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  // User-scoped providers (user can manage these)
  const userKeys = await prisma.providerApiKey.findMany({
    where: { userId: authResult.user.id },
    select: {
      id: true,
      provider: true,
      label: true,
      baseUrl: true,
      contextWindow: true,
      maxOutputTokens: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { provider: "asc" },
  });

  // Global providers (read-only for users)
  const globalKeys = await prisma.providerApiKey.findMany({
    where: { userId: null },
    select: {
      provider: true,
      label: true,
      baseUrl: true,
      contextWindow: true,
      maxOutputTokens: true,
    },
    orderBy: { provider: "asc" },
  });

  const globalProviderIds = new Set(globalKeys.map((k) => k.provider));

  return NextResponse.json({
    providers: userKeys.map((k) => ({
      ...k,
      configured: true,
      isGlobal: false,
      displayName: PROVIDERS[k.provider as keyof typeof PROVIDERS]?.label ?? k.provider,
    })),
    globalProviders: globalKeys.map((k) => ({
      ...k,
      configured: true,
      isGlobal: true,
      displayName: PROVIDERS[k.provider as keyof typeof PROVIDERS]?.label ?? k.provider,
    })),
    availableProviders: Object.entries(PROVIDERS).map(([key, val]) => ({
      id: key,
      name: val.label,
      configured: userKeys.some((u) => u.provider === key) || globalProviderIds.has(key),
      // Only providers whose models Saale defines itself can have their metadata
      // (limits, capabilities) configured — Pi's catalog already knows the rest.
      modelsConfigurable: definesProviderModels(key),
    })),
  });
}

/**
 * POST /api/providers — Add or update a provider API key
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { provider, apiKey, label, baseUrl } = body;

  if (!provider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }

  // apiKey is optional for local servers
  if (apiKey && (typeof apiKey !== "string" || apiKey.length < 3)) {
    return NextResponse.json(
      { error: "API key must be at least 3 characters if provided" },
      { status: 400 },
    );
  }

  // For custom providers, baseUrl is required
  if (provider === "custom" && (!baseUrl || typeof baseUrl !== "string" || baseUrl.length < 5)) {
    return NextResponse.json(
      { error: "Base URL is required for OpenAI-compatible providers" },
      { status: 400 },
    );
  }

  // Encrypt the API key (use empty string if not provided)
  const encryptedKey = encrypt(apiKey || "");

  const parsedLimits = parseProviderLimits(provider, body);
  if ("error" in parsedLimits) {
    return NextResponse.json({ error: parsedLimits.error }, { status: 400 });
  }

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
      baseUrl: provider === "custom" ? baseUrl : null,
      ...parsedLimits.limits,
    },
    update: {
      encryptedKey,
      label: label || "",
      baseUrl: provider === "custom" ? baseUrl : null,
      ...parsedLimits.limits,
    },
  });

  // For custom providers, try to discover models, and ask the endpoint what
  // those models can do while we are here — an import is where Saale learns
  // that a local vision model accepts images.
  let discoveredModels: string[] = [];
  let modelError: string | undefined;
  let visionModels = 0;

  if (provider === "custom" && baseUrl) {
    const result = await fetchOpenAIModels(baseUrl, apiKey || undefined);
    discoveredModels = result.models;
    modelError = result.error;

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
  }

  return NextResponse.json({
    provider: key.provider,
    label: key.label,
    baseUrl: key.baseUrl,
    contextWindow: key.contextWindow,
    maxOutputTokens: key.maxOutputTokens,
    configured: true,
    displayName: PROVIDERS[key.provider as keyof typeof PROVIDERS]?.label ?? key.provider,
    discoveredModels,
    modelCount: discoveredModels.length,
    visionModels,
    modelError,
  });
}

/**
 * PATCH /api/providers — Update a provider's model limits without touching its
 * API key (so the UI never has to re-submit a stored credential).
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const provider = body.provider;

  if (!provider || typeof provider !== "string") {
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
 * DELETE /api/providers — Remove a provider API key
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
