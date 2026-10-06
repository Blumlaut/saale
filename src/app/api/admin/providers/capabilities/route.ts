import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { requireAdmin } from "../../settings/auth";
import { parseVisionEdit } from "@/lib/providers/capabilities";
import {
  detectAndStoreProviderCapabilities,
  rejectUnconfigurableProvider,
  setProviderModelVision,
} from "@/lib/providers/provider-capabilities";

/**
 * The global provider key (admin-managed), which is what every tenant inherits
 * when they have no key of their own.
 */
async function findGlobalProviderKey(provider: string) {
  return prisma.providerApiKey.findFirst({
    where: { userId: null, provider },
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
 * PATCH /api/admin/providers/capabilities — Record what a global provider's
 * model can do.
 *
 * Body: `{ provider, modelId, vision }` — `vision: null` puts the model back on
 * automatic detection.
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();

  const providerError = rejectUnconfigurableProvider(body.provider);
  if (providerError) return NextResponse.json({ error: providerError }, { status: 400 });

  const edit = parseVisionEdit(body);
  if ("error" in edit) return NextResponse.json({ error: edit.error }, { status: 400 });

  const key = await findGlobalProviderKey(body.provider);
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
 * POST /api/admin/providers/capabilities — Ask a global provider's endpoint what
 * its models can do and store the answers.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const providerError = rejectUnconfigurableProvider(body.provider);
  if (providerError) return NextResponse.json({ error: providerError }, { status: 400 });

  const provider: string = body.provider;
  const key = await findGlobalProviderKey(provider);
  if (!key) {
    return NextResponse.json({ error: "Provider is not configured" }, { status: 404 });
  }

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
