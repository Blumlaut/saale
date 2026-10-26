import { normalizeThinkingLevelSetting } from "@/lib/pi/thinking-levels";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { scheduleAgentDefinition, unscheduleAgentDefinition } from "@/lib/queue";
import { SYSTEM_MANAGED_ERROR } from "@/lib/agent-jobs/system-managed";
import { normalizeRunAt } from "@/lib/agent-jobs/schedule";
import { toStoredModelId } from "@/lib/pi/model-ref";

/**
 * GET /api/agent-jobs/definitions/:id. Get a single definition
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const definition = await prisma.agentDefinition.findFirst({
    where: { id, userId: authResult.user.id },
  });

  if (!definition) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
      systemManaged: definition.systemManaged,
      createdAt: definition.createdAt.toISOString(),
      updatedAt: definition.updatedAt.toISOString(),
    },
  });
}

/**
 * PATCH /api/agent-jobs/definitions/:id. Update a definition
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const existing = await prisma.agentDefinition.findFirst({
    where: { id, userId: authResult.user.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // System-managed definitions (e.g. the Telegram chat agent) are read-only.
  if (existing.systemManaged) {
    return NextResponse.json({ error: SYSTEM_MANAGED_ERROR }, { status: 403 });
  }

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

  let resolvedModelId = existing.modelId;
  if (modelId !== undefined) {
    resolvedModelId = modelId ? toStoredModelId(modelId) : null;
  }

  // One-off `runAt` and cron are mutually exclusive. Parse both supplied
  // values first, then let a non-null runAt win over cron (and vice versa).
  let nextRunAt = existing.runAt;
  let nextCron = existing.cronExpression;
  try {
    if (runAt !== undefined) nextRunAt = normalizeRunAt(runAt);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  if (cronExpression !== undefined) nextCron = cronExpression || null;
  if (runAt !== undefined && nextRunAt) {
    nextCron = null;
  } else if (nextCron) {
    nextRunAt = null;
  }

  const updated = await prisma.agentDefinition.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(description !== undefined ? { description: description?.trim() || null } : {}),
      ...(prompt !== undefined ? { prompt: prompt.trim() } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt: systemPrompt?.trim() || null } : {}),
      ...(toolConfig !== undefined ? { toolConfig } : {}),
      ...(modelId !== undefined ? { modelId: resolvedModelId } : {}),
      ...(thinkingLevel !== undefined
        ? { thinkingLevel: normalizeThinkingLevelSetting(thinkingLevel) }
        : {}),
      ...(outputChannel !== undefined ? { outputChannel: outputChannel || null } : {}),
      ...(outputChannelId !== undefined ? { outputChannelId: outputChannelId || null } : {}),
      ...(cronExpression !== undefined || runAt !== undefined
        ? { cronExpression: nextCron, runAt: nextRunAt }
        : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    },
  });

  // Resync the BullMQ schedule: BullMQ does not update an existing scheduler
  // with the same jobId, so remove first, then re-add if scheduled.
  await unscheduleAgentDefinition(updated.id);
  if (updated.enabled && (updated.runAt || updated.cronExpression)) {
    await scheduleAgentDefinition(updated).catch((err) => {
      console.error(
        `Failed to re-schedule agent definition ${updated.id} (${updated.runAt?.toISOString() ?? updated.cronExpression}):`,
        err,
      );
    });
  }

  return NextResponse.json({
    definition: {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      prompt: updated.prompt,
      systemPrompt: updated.systemPrompt,
      toolConfig: updated.toolConfig as Record<string, boolean> | null,
      modelId: updated.modelId,
      thinkingLevel: updated.thinkingLevel,
      outputChannel: updated.outputChannel,
      outputChannelId: updated.outputChannelId,
      cronExpression: updated.cronExpression,
      runAt: updated.runAt?.toISOString() ?? null,
      lastRunAt: updated.lastRunAt?.toISOString(),
      enabled: updated.enabled,
      systemManaged: updated.systemManaged,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/agent-jobs/definitions/:id. Delete a definition (and its runs)
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const existing = await prisma.agentDefinition.findFirst({
    where: { id, userId: authResult.user.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // System-managed definitions are owned by Saale. deleting one would just
  // make the next Telegram message recreate it with defaults.
  if (existing.systemManaged) {
    return NextResponse.json({ error: SYSTEM_MANAGED_ERROR }, { status: 403 });
  }

  await prisma.agentDefinition.delete({ where: { id } });

  // Remove the BullMQ repeatable job so the deleted definition stops firing
  await unscheduleAgentDefinition(id);

  return NextResponse.json({ deleted: true, id });
}
