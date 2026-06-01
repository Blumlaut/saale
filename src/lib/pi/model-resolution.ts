import { prisma } from "@/lib/db";

/**
 * Resolve the model to use for a specific purpose.
 *
 * Priority:
 * 1. Explicit modelId override (e.g. from a job config)
 * 2. Purpose-specific override from AppSettings.purposeModelOverrides
 * 3. Global default from AppSettings.defaultModelProvider/defaultModelName
 *
 * @returns { provider, name } or undefined if no model can be resolved
 */
export async function resolveModelForPurpose(
  userId: string,
  purpose: string,
  explicitModelId?: string | null,
): Promise<{ provider: string; name: string } | undefined> {
  // 1. Explicit override (e.g. per-job model selection)
  if (explicitModelId && explicitModelId.includes(":")) {
    const [provider, ...nameParts] = explicitModelId.split(":");
    if (provider) {
      return { provider, name: nameParts.join(":") };
    }
  }

  // 2. Fetch user settings (covers both purpose override and global default)
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: {
      defaultModelProvider: true,
      defaultModelName: true,
      purposeModelOverrides: true,
    },
  });

  if (!settings) return undefined;

  // 3. Purpose-specific override
  const overrides = settings.purposeModelOverrides as Record<
    string,
    { provider: string; model: string }
  > | null;
  if (overrides?.[purpose]?.provider && overrides[purpose]?.model) {
    return {
      provider: overrides[purpose].provider,
      name: overrides[purpose].model,
    };
  }

  // 4. Global default
  if (settings.defaultModelProvider && settings.defaultModelName) {
    return {
      provider: settings.defaultModelProvider,
      name: settings.defaultModelName,
    };
  }

  return undefined;
}
