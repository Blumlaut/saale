import { findToolInfo, resolveTemplate } from "./tool-infos";
import { prisma } from "@/lib/db";

/**
 * Server-side tool summary resolver.
 *
 * For most tools, delegates to the template in {@link ALL_TOOL_INFOS}.
 * For infra tools with machine IDs, resolves the machine name first
 * and injects it into the args before template resolution.
 */
export async function resolveToolSummary(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
): Promise<string | null> {
  // Infra tools may need machine name resolution
  if (toolName.startsWith("infra_")) {
    return resolveInfraSummary(toolName, args, userId);
  }

  const info = findToolInfo(toolName);
  if (!info?.summaryTemplate) return null;

  return resolveTemplate(info.summaryTemplate, args);
}

/**
 * Resolve machine ID(s) to names (when needed) and format the summary.
 *
 * Tools with an `id` or `machineId` arg that reference InfraMachine
 * records get their name substituted into the template.
 * Tools without a machine ID (e.g. infra_notes_get, infra_add_machine)
 * use their template directly if one exists.
 */
async function resolveInfraSummary(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
): Promise<string | null> {
  const info = findToolInfo(toolName);
  if (!info?.summaryTemplate) return null;

  // If the template needs machineName, try to resolve it from args
  const needsMachineName = info.summaryTemplate.includes("{machineName}");

  if (needsMachineName) {
    const machineId = args.machineId ?? args.id;
    if (machineId && typeof machineId === "string") {
      const machine = await prisma.infraMachine.findFirst({
        where: { id: machineId, userId },
        select: { name: true },
      });

      if (machine) {
        return resolveTemplate(info.summaryTemplate, {
          ...args,
          machineName: machine.name,
        });
      }
    }

    // Machine not found — fall back without machineName
    // (leaves {machineName} in output as a clear signal)
  }

  // Template doesn't need machineName (e.g. infra_add_machine uses {name})
  return resolveTemplate(info.summaryTemplate, args);
}
