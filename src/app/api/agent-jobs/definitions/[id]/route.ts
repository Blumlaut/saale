import { normalizeThinkingLevelSetting } from "@/lib/pi/thinking-levels";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { scheduleAgentDefinition, unscheduleAgentDefinition } from "@/lib/queue";
import {
  isReservedAgentName,
  RESERVED_AGENT_NAME_ERROR,
  SYSTEM_MANAGED_ERROR,
} from "@/lib/agent-jobs/system-managed";

/**
 * GET /api/agent-jobs/definitions/:id — Get a single definition
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
      lastRunAt: definition.lastRunAt?.toISOString(),
      enabled: definition.enabled,
      systemManaged: definition.systemManaged,
      createdAt: definition.createdAt.toISOString(),
      updatedAt: definition.updatedAt.toISOString(),
    },
  });
}

/**
 * PATCH /api/agent-jobs/definitions/:id — Update a definition
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
    enabled,
  } = body;

  // Normalize modelId format
  let resolvedModelId = existing.modelId;
  if (modelId !== undefined) {
    const raw = modelId || null;
    resolvedModelId = raw?.includes("/") ? raw.replace("/", ":") : raw;
  }

  // The Telegram chat agent name is reserved — renaming to it would silently
  // hijack the telegram definition lookup (which matches by name).
  if (name !== undefined && isReservedAgentName(name)) {
    return NextResponse.json({ error: RESERVED_AGENT_NAME_ERROR }, { status: 400 });
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
      ...(cronExpression !== undefined ? { cronExpression: cronExpression || null } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    },
  });

  // Resync the BullMQ repeatable job: BullMQ does not update an existing
  // scheduler with the same jobId, so remove first, then re-add if scheduled.
  await unscheduleAgentDefinition(updated.id);
  if (updated.enabled && updated.cronExpression) {
    await scheduleAgentDefinition(updated).catch((err) => {
      console.error(
        `Failed to re-schedule agent definition ${updated.id} (${updated.cronExpression}):`,
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
      lastRunAt: updated.lastRunAt?.toISOString(),
      enabled: updated.enabled,
      systemManaged: updated.systemManaged,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/agent-jobs/definitions/:id — Delete a definition (and its runs)
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

  // System-managed definitions are owned by Saale — deleting one would just
  // make the next Telegram message recreate it with defaults.
  if (existing.systemManaged) {
    return NextResponse.json({ error: SYSTEM_MANAGED_ERROR }, { status: 403 });
  }

  await prisma.agentDefinition.delete({ where: { id } });

  // Remove the BullMQ repeatable job so the deleted definition stops firing
  await unscheduleAgentDefinition(id);

  return NextResponse.json({ deleted: true, id });
}
