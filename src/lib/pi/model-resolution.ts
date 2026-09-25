import { prisma } from "@/lib/db";

/**
 * Split a `provider:modelId` (Saale's job format) or `provider/modelId` (Pi's
 * canonical form) reference.
 *
 * Only the FIRST separator is the provider boundary: model ids contain both
 * characters — `openrouter:anthropic/claude-sonnet-4`, `openai/gpt-5:exacto` —
 * so splitting on a later one, or rewriting the id's own separator, changes the
 * model identity and the runtime can no longer resolve it.
 *
 * @returns The provider and model id, or undefined when the reference carries no
 *   provider prefix (a bare model id is not resolvable on its own).
 */
export function splitModelReference(
  modelReference: string | null | undefined,
): { provider: string; name: string } | undefined {
  const reference = modelReference?.trim();
  if (!reference) return undefined;

  const separator = reference.search(/[:/]/);
  if (separator <= 0) return undefined;

  const provider = reference.slice(0, separator);
  const name = reference.slice(separator + 1);
  if (!provider || !name) return undefined;

  return { provider, name };
}

/**
 * Resolve the model to use for a specific purpose.
 *
 * Priority:
 * 1. Explicit modelId override (e.g. from a job config)
 * 2. Purpose-specific override from AppSettings.purposeModelOverrides
 * 3. User default from AppSettings.defaultModelProvider/defaultModelName
 * 4. Global admin default from AdminSettings.globalModelProvider/globalModelName
 *
 * @returns { provider, name } or undefined if no model can be resolved
 */
export async function resolveModelForPurpose(
  userId: string,
  purpose: string,
  explicitModelId?: string | null,
): Promise<{ provider: string; name: string } | undefined> {
  // 1. Explicit override (e.g. per-job model selection)
  const explicit = splitModelReference(explicitModelId);
  if (explicit) return explicit;

  // 2. Fetch user settings (covers both purpose override and user default)
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: {
      defaultModelProvider: true,
      defaultModelName: true,
      purposeModelOverrides: true,
    },
  });

  // A missing settings row must not skip the admin default below (the user
  // simply has no override of their own).
  const overrides = (settings?.purposeModelOverrides ?? null) as Record<
    string,
    { provider: string; model: string }
  > | null;

  // 3. Purpose-specific override
  if (overrides?.[purpose]?.provider && overrides[purpose]?.model) {
    return {
      provider: overrides[purpose].provider,
      name: overrides[purpose].model,
    };
  }

  // 4. User default
  if (settings?.defaultModelProvider && settings.defaultModelName) {
    return {
      provider: settings.defaultModelProvider,
      name: settings.defaultModelName,
    };
  }

  // 5. Global admin default (fallback)
  const adminSettings = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { globalModelProvider: true, globalModelName: true },
  });
  if (adminSettings?.globalModelProvider && adminSettings?.globalModelName) {
    return {
      provider: adminSettings.globalModelProvider,
      name: adminSettings.globalModelName,
    };
  }

  return undefined;
}
