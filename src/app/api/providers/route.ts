import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { encrypt, decrypt } from "@/lib/crypto";

// Known providers with their API key prefixes for validation
const PROVIDERS = {
  anthropic: { label: "Anthropic", prefix: "sk-ant-" },
  openai: { label: "OpenAI", prefix: "sk-" },
  google: { label: "Google", prefix: "AIza" },
  deepseek: { label: "DeepSeek", prefix: "sk-" },
  xai: { label: "xAI (Grok)", prefix: "xai-" },
  groq: { label: "Groq", prefix: "gsk_" },
  cerebras: { label: "Cerebras", prefix: "pk-" },
  openrouter: { label: "OpenRouter", prefix: "sk-or-" },
  mistral: { label: "Mistral", prefix: "x-" },
  together: { label: "Together AI", prefix: "sk-" },
  fireworks: { label: "Fireworks", prefix: "fw_" },
  huggingface: { label: "Hugging Face", prefix: "hf_" },
  custom: { label: "Custom (OpenAI compat)", prefix: "" },
};

/**
 * GET /api/providers — List user's configured providers
 */
export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const keys = await prisma.providerApiKey.findMany({
    where: { userId: session.user.id },
    select: {
      id: true,
      provider: true,
      label: true,
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
 * POST /api/providers — Add or update a provider API key
 */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { provider, apiKey, label } = body;

  if (!provider || !apiKey) {
    return NextResponse.json(
      { error: "provider and apiKey are required" },
      { status: 400 },
    );
  }

  if (typeof apiKey !== "string" || apiKey.length < 10) {
    return NextResponse.json(
      { error: "API key must be at least 10 characters" },
      { status: 400 },
    );
  }

  // Encrypt the API key
  const encryptedKey = encrypt(apiKey);

  const key = await prisma.providerApiKey.upsert({
    where: {
      userId_provider: {
        userId: session.user.id,
        provider,
      },
    },
    create: {
      userId: session.user.id,
      provider,
      encryptedKey,
      label: label || "",
    },
    update: {
      encryptedKey,
      label: label || "",
    },
  });

  return NextResponse.json({
    provider: key.provider,
    label: key.label,
    configured: true,
    displayName: PROVIDERS[key.provider as keyof typeof PROVIDERS]?.label ?? key.provider,
  });
}

/**
 * DELETE /api/providers — Remove a provider API key
 */
export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider");

  if (!provider) {
    return NextResponse.json(
      { error: "provider query parameter is required" },
      { status: 400 },
    );
  }

  await prisma.providerApiKey.deleteMany({
    where: {
      userId: session.user.id,
      provider,
    },
  });

  return NextResponse.json({ success: true, provider });
}
