import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { parseVisionEdit } from "@/lib/providers/capabilities";
import {
  detectAndStoreProviderCapabilities,
  rejectUnconfigurableProvider,
  setProviderModelVision,
} from "@/lib/providers/provider-capabilities";

/** The authenticated user's provider key, scoped so no other tenant's is reachable. */
async function findProviderKey(userId: string, provider: string) {
  return prisma.providerApiKey.findUnique({
    where: { userId_provider: { userId, provider } },
    select: {
      id: true,
      provider: true,
      baseUrl: true,
      encryptedKey: true,
      modelCapabilities: true,
    },
  });
}

/**
 * PATCH /api/providers/capabilities — Record what a model can do.
 *
 * Body: `{ provider, modelId, vision }` — `vision: null` puts the model back on
 * automatic detection.
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();

  // Validate the request before touching the database.
  const providerError = rejectUnconfigurableProvider(body.provider);
  if (providerError) return NextResponse.json({ error: providerError }, { status: 400 });

  const edit = parseVisionEdit(body);
  if ("error" in edit) return NextResponse.json({ error: edit.error }, { status: 400 });

  const key = await findProviderKey(authResult.user.id, body.provider);
  if (!key) {
    return NextResponse.json({ error: "Provider is not configured" }, { status: 404 });
  }

  const modelCapabilities = await setProviderModelVision({
    keyId: key.id,
    stored: key.modelCapabilities,
    modelId: edit.modelId,
    vision: edit.vision,
  });

  return NextResponse.json({ provider: key.provider, modelCapabilities });
}

/**
 * POST /api/providers/capabilities — Ask the endpoint what its models can do and
 * store the answers.
 *
 * Detection is explicit rather than part of building the runtime: `/props` costs
 * a request per model, and the runtime is rebuilt for every session, job and
 * Telegram message.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const providerError = rejectUnconfigurableProvider(body.provider);
  if (providerError) return NextResponse.json({ error: providerError }, { status: 400 });

  const provider: string = body.provider;
  const key = await findProviderKey(authResult.user.id, provider);
  if (!key) {
    return NextResponse.json({ error: "Provider is not configured" }, { status: 404 });
  }

  // The stored base URL, never one from the request: this route must not become
  // a way to make the server issue requests to an arbitrary host.
  const baseUrl = key.baseUrl;
  if (!baseUrl) {
    return NextResponse.json({ error: "Provider has no base URL to probe" }, { status: 400 });
  }

  const summary = await detectAndStoreProviderCapabilities({
    keyId: key.id,
    stored: key.modelCapabilities,
    baseUrl,
    apiKey: decrypt(key.encryptedKey) || undefined,
  });

  return NextResponse.json({ provider: key.provider, ...summary });
}
