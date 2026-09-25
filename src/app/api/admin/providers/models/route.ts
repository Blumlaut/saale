import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { requireAdmin } from "../../settings/auth";
import { registerDiscoveredModels } from "@/lib/pi/models";
import { DISCOVERABLE_PROVIDERS, getProviderBaseUrl } from "@/lib/providers/config";
import { PI_DEFAULT_CONTEXT_WINDOW, PI_DEFAULT_MAX_OUTPUT_TOKENS } from "@/lib/providers/limits";

/**
 * GET /api/admin/providers/models — List models available from global providers only.
 * Used by the admin models page to show/enable/disable models globally.
 */
export async function GET() {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  // Fetch only global providers
  const globalKeys = await prisma.providerApiKey.findMany({
    where: { userId: null },
    select: { provider: true, encryptedKey: true, baseUrl: true },
  });

  // Credentials come from the database only. `ModelRuntime.create()` would
  // otherwise read the host's ~/.pi/agent/auth.json, models.json and
  // models-store.json (SDK docs, "Credential priority"), handing every tenant
  // the operator's provider keys and private endpoints — and writing fetched
  // catalogs into the operator's Pi directory.
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });

  // Set runtime API keys
  for (const key of globalKeys) {
    try {
      const decryptedKey = decrypt(key.encryptedKey);
      if (decryptedKey) {
        await modelRuntime.setRuntimeApiKey(key.provider, decryptedKey);
      }
    } catch (err) {
      console.error(`Failed to decrypt key for provider ${key.provider}:`, err);
    }
  }

  const discoveredModels: Array<{
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
  }> = [];

  for (const key of globalKeys) {
    const baseUrl =
      key.provider === "custom"
        ? key.baseUrl
        : DISCOVERABLE_PROVIDERS.has(key.provider)
          ? getProviderBaseUrl(key.provider)
          : null;
    if (!baseUrl) continue;

    // Limits are per-provider user settings; the admin page only lists models,
    // so uncatalogued ids take Pi's defaults rather than the admin route's own
    // hardcoded numbers.
    const limits = {
      contextWindow: PI_DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: PI_DEFAULT_MAX_OUTPUT_TOKENS,
    };

    try {
      const modelIds = await registerDiscoveredModels(modelRuntime, {
        provider: key.provider,
        baseUrl,
        apiKey: decrypt(key.encryptedKey),
        limits,
      });
      for (const m of modelIds) {
        discoveredModels.push({
          provider: key.provider,
          id: m,
          name: m,
          reasoning: modelRuntime.getModel(key.provider, m)?.reasoning ?? false,
        });
      }
    } catch (err) {
      console.error(`Failed to register discovered provider ${key.provider}:`, err);
    }
  }

  // Merge: start with built-in available models, then add discovered custom models
  const available = modelRuntime.getAvailableSnapshot();
  const allModels = available.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
    // The catalog's own flag — the page used to guess it from the model id
    // (any id containing "r1"), which marked non-thinking models as reasoners.
    reasoning: m.reasoning,
  }));

  // Add discovered custom models (not already in built-in list)
  const knownIds = new Set(allModels.map((m) => `${m.provider}:${m.id}`));
  for (const dm of discoveredModels) {
    if (!knownIds.has(`${dm.provider}:${dm.id}`)) {
      allModels.push(dm);
    }
  }

  // Group by provider
  const models: Record<string, Array<{ id: string; name: string; reasoning: boolean }>> = {};
  const providerSet = new Set<string>();

  for (const m of allModels) {
    providerSet.add(m.provider);
    if (!models[m.provider]) {
      models[m.provider] = [];
    }
    const list = models[m.provider]!;
    list.push({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
    });
  }

  const providers = Array.from(providerSet).map((id) => ({
    id,
    name: modelRuntime.getProvider(id)?.name ?? id,
    modelCount: (models[id] ?? []).length,
  }));

  return NextResponse.json({ models, providers });
}
