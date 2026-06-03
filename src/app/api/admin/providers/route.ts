import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "../settings/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";

// Known providers with their labels
const PROVIDERS = {
  anthropic: { label: "Anthropic" },
  openai: { label: "OpenAI" },
  google: { label: "Google" },
  deepseek: { label: "DeepSeek" },
  xai: { label: "xAI (Grok)" },
  groq: { label: "Groq" },
  cerebras: { label: "Cerebras" },
  openrouter: { label: "OpenRouter" },
  mistral: { label: "Mistral" },
  together: { label: "Together AI" },
  fireworks: { label: "Fireworks" },
  huggingface: { label: "Hugging Face" },
  custom: { label: "OpenAI-compatible" },
};

/**
 * Fetch models from an OpenAI-compatible /models endpoint.
 */
async function fetchOpenAIModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data?.data?.length) return [];
    return data.data.map((m: { id: string }) => m.id).slice(0, 200);
  } catch {
    return [];
  }
}

/**
 * GET /api/admin/providers — List global providers
 */
export async function GET() {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  const keys = await prisma.providerApiKey.findMany({
    where: { userId: null },
    select: {
      id: true,
      provider: true,
      label: true,
      baseUrl: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { provider: "asc" },
  });

  return NextResponse.json({
    providers: keys.map((k) => ({
      ...k,
      configured: true,
      displayName: PROVIDERS[k.provider as keyof typeof PROVIDERS]?.label ?? k.provider,
    })),
    availableProviders: Object.entries(PROVIDERS).map(([key, val]) => ({
      id: key,
      name: val.label,
    })),
  });
}

/**
 * POST /api/admin/providers — Add or update a global provider
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { provider, apiKey, label, baseUrl } = body;

  if (!provider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }

  if (apiKey && (typeof apiKey !== "string" || apiKey.length < 3)) {
    return NextResponse.json(
      { error: "API key must be at least 3 characters if provided" },
      { status: 400 },
    );
  }

  if (provider === "custom" && (!baseUrl || typeof baseUrl !== "string" || baseUrl.length < 5)) {
    return NextResponse.json(
      { error: "Base URL is required for OpenAI-compatible providers" },
      { status: 400 },
    );
  }

  const encryptedKey = encrypt(apiKey || "");

  // Upsert: find existing global provider or create new one
  const existing = await prisma.providerApiKey.findFirst({
    where: {
      userId: null,
      provider,
    },
  });

  const key = existing
    ? await prisma.providerApiKey.update({
        where: { id: existing.id },
        data: {
          encryptedKey,
          label: label || "",
          baseUrl: provider === "custom" ? baseUrl : null,
        },
      })
    : await prisma.providerApiKey.create({
        data: {
          userId: null,
          provider,
          encryptedKey,
          label: label || "",
          baseUrl: provider === "custom" ? baseUrl : null,
        },
      });

  // For custom providers, try to discover models
  let discoveredModels: string[] = [];
  if (provider === "custom" && baseUrl) {
    discoveredModels = await fetchOpenAIModels(baseUrl, apiKey || undefined);
  }

  return NextResponse.json({
    provider: key.provider,
    label: key.label,
    baseUrl: key.baseUrl,
    configured: true,
    displayName: PROVIDERS[key.provider as keyof typeof PROVIDERS]?.label ?? key.provider,
    discoveredModels,
    modelCount: discoveredModels.length,
  });
}

/**
 * DELETE /api/admin/providers — Remove a global provider
 */
export async function DELETE(request: NextRequest) {
  const authResult = await requireAdmin();
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
