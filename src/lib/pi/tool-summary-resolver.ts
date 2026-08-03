import { prisma } from "@/lib/db";
import { formatToolSummary } from "./tool-infos";

/**
 * Server-side tool summary resolver.
 *
 * For most tools, delegates to the template-based {@link formatToolSummary}.
 * For infra tools, resolves machine IDs to names before formatting.
 */
export async function resolveToolSummary(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  // Infra tools need machine name resolution
  if (toolName.startsWith("infra_")) {
    return resolveInfraSummary(toolName, args);
  }

  return formatToolSummary(toolName, args);
}

/**
 * Resolve machine ID(s) to names and format the summary.
 * Uses a simple convention: tools with an `id` or `machineId` arg
 * that reference InfraMachine records get their name substituted.
 */
async function resolveInfraSummary(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const machineId = args.machineId ?? args.id;
  if (!machineId || typeof machineId !== "string") {
    return formatToolSummary(toolName, args);
  }

  const machine = await prisma.infraMachine.findUnique({
    where: { id: machineId },
    select: { name: true },
  });

  if (!machine) {
    return formatToolSummary(toolName, args);
  }

  // Augment args with the resolved machine name
  const resolvedArgs = { ...args, machineName: machine.name };

  // Use tool-specific templates that reference {machineName}
  const infraTemplates: Record<string, string> = {
    infra_exec: "running {command} on {machineName}",
    infra_write_file: "writing to {path} on {machineName}",
    infra_notes_list: "listing notes for {machineName}",
    infra_notes_get: "reading note on {machineName}",
    infra_notes_upsert: "saving note on {machineName}",
    infra_notes_delete: "deleting note on {machineName}",
  };

  const template = infraTemplates[toolName];
  if (!template) return formatToolSummary(toolName, args);

  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = resolvedArgs[key as keyof typeof resolvedArgs];
    if (value === undefined || value === null) return `{${key}}`;
    return typeof value === "string" ? value : String(value);
  });
}
