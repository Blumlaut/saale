import { normalizeThinkingLevelSetting } from "@/lib/pi/thinking-levels";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { scheduleAgentDefinition } from "@/lib/queue";
import { isReservedAgentName, RESERVED_AGENT_NAME_ERROR } from "@/lib/agent-jobs/system-managed";
import { normalizeRunAt } from "@/lib/agent-jobs/schedule";

/**
 * GET /api/agent-jobs/definitions. List user's agent job definitions
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const definitions = await prisma.agentDefinition.findMany({
    where: { userId: authResult.user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      description: true,
      prompt: true,
      systemPrompt: true,
      toolConfig: true,
      modelId: true,
      thinkingLevel: true,
      outputChannel: true,
      outputChannelId: true,
      cronExpression: true,
      runAt: true,
      lastRunAt: true,
      enabled: true,
      systemManaged: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { runs: true } },
    },
  });

  // Fetch latest run status for each definition (one row per definition)
  const definitionIds = definitions.map((d) => d.id);
  const latestRuns = definitionIds.length
    ? await prisma.$queryRaw<
        Array<{ definitionId: string; status: string; completedAt: Date | null }>
      >(
        Prisma.sql`SELECT DISTINCT ON ("definitionId") "definitionId", status, "completedAt"
                   FROM "AgentRun"
                   WHERE "definitionId" = ANY(${definitionIds})
                   ORDER BY "definitionId", "createdAt" DESC`,
      )
    : [];
  const latestRunMap = new Map<string, { status: string; completedAt: Date | null }>();
  for (const run of latestRuns) {
    latestRunMap.set(run.definitionId, { status: run.status, completedAt: run.completedAt });
  }

  return NextResponse.json({
    definitions: definitions.map(
      (d: {
        id: string;
        name: string;
        description: string | null;
        prompt: string;
        systemPrompt: string | null;
        toolConfig: unknown;
        modelId: string | null;
        thinkingLevel: string;
        outputChannel: string | null;
        outputChannelId: string | null;
        cronExpression: string | null;
        runAt: Date | null;
        lastRunAt: Date | null;
        enabled: boolean;
        systemManaged: boolean;
        createdAt: Date;
        updatedAt: Date;
        _count: { runs: number };
      }) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        prompt: d.prompt,
        systemPrompt: d.systemPrompt,
        toolConfig: d.toolConfig as Record<string, boolean> | null,
        modelId: d.modelId,
        thinkingLevel: d.thinkingLevel,
        outputChannel: d.outputChannel,
        outputChannelId: d.outputChannelId,
        cronExpression: d.cronExpression,
        runAt: d.runAt?.toISOString() ?? null,
        lastRunAt: d.lastRunAt?.toISOString(),
        enabled: d.enabled,
        systemManaged: d.systemManaged,
        runCount: d._count.runs,
        latestRun: latestRunMap.get(d.id) ?? null,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      }),
    ),
  });
}

/**
 * POST /api/agent-jobs/definitions. Create a new agent job definition
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const {
    name,
    description,
    prompt,
    systemPrompt,
    toolConfig,
    modelId,
    thinkingLevel,
    outputChannel,
    outputChannelId,
    cronExpression,
    runAt,
    enabled,
  } = body;

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!prompt?.trim()) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }
  if (isReservedAgentName(name)) {
    return NextResponse.json({ error: RESERVED_AGENT_NAME_ERROR }, { status: 400 });
  }

  let resolvedRunAt: Date | null;
  try {
    resolvedRunAt = normalizeRunAt(runAt);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  // One-off `runAt` and cron are mutually exclusive: a one-off job has no
  // recurring schedule, and a cron job has no single run time.
  const resolvedCron = resolvedRunAt ? null : cronExpression || null;

  // Normalize modelId format
  const rawModelId = modelId || null;
  const resolvedModelId = rawModelId?.includes("/") ? rawModelId.replace("/", ":") : rawModelId;

  const definition = await prisma.agentDefinition.create({
    data: {
      userId: authResult.user.id,
      name: name.trim(),
      description: description?.trim() || null,
      prompt: prompt.trim(),
      systemPrompt: systemPrompt?.trim() || null,
      toolConfig: toolConfig ?? null,
      modelId: resolvedModelId,
      thinkingLevel: normalizeThinkingLevelSetting(thinkingLevel),
      outputChannel: outputChannel || null,
      outputChannelId: outputChannelId || null,
      cronExpression: resolvedCron,
      runAt: resolvedRunAt,
      enabled: enabled !== false,
    },
  });

  // Register the BullMQ schedule if the definition has one
  if (definition.enabled && (definition.runAt || definition.cronExpression)) {
    await scheduleAgentDefinition(definition).catch((err) => {
      console.error(
        `Failed to schedule agent definition ${definition.id} (${definition.runAt?.toISOString() ?? definition.cronExpression}):`,
        err,
      );
    });
  }

  return NextResponse.json({
    definition: {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      prompt: definition.prompt,
      systemPrompt: definition.systemPrompt,
      toolConfig: definition.toolConfig as Record<string, boolean> | null,
      modelId: definition.modelId,
      thinkingLevel: definition.thinkingLevel,
      outputChannel: definition.outputChannel,
      outputChannelId: definition.outputChannelId,
      cronExpression: definition.cronExpression,
      runAt: definition.runAt?.toISOString() ?? null,
      lastRunAt: definition.lastRunAt?.toISOString(),
      enabled: definition.enabled,
      systemManaged: false,
      createdAt: definition.createdAt.toISOString(),
      updatedAt: definition.updatedAt.toISOString(),
    },
  });
}
