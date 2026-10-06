import { prisma } from "@/lib/db";
import { splitModelReference } from "./model-ref";

// Re-exported so callers (and tests) reach the parser through this module.
export { splitModelReference };

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
