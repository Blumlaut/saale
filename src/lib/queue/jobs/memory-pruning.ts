import { prisma } from "@/lib/db";

export const metadata = {
  type: "memory_pruning",
  label: "Memory Pruning",
  description: "Remove stale and unused memories",
  icon: "ScissorsLine",
  defaultCron: "0 0 * * 0",
  usesAi: false,
} as const;

export const fields = [
  {
    key: "unusedDays",
    label: "Unused threshold",
    description: "Delete memories with 0 accesses older than this many days",
    type: "number" as const,
    default: 90,
    min: 30,
    max: 365,
  },
];

export async function handler(params: { config: Record<string, unknown>; userId: string }) {
  const { config, userId } = params;
  const unusedDays = (config.unusedDays as number) ?? 90;

  const unusedCutoff = new Date(Date.now() - unusedDays * 24 * 60 * 60 * 1000);

  // Delete unused memories (0 accesses, older than threshold)
  const unusedDeleted = await prisma.memory.deleteMany({
    where: {
      userId,
      accessCount: 0,
      createdAt: { lt: unusedCutoff },
    },
  });

  // Reset access counts for next cycle
  await prisma.memory.updateMany({
    where: { userId },
    data: { accessCount: 0 },
  });

  return JSON.stringify({
    unusedDeleted: unusedDeleted.count,
    totalDeleted: unusedDeleted.count,
  });
}
