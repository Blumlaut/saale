import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

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
      enabled: definition.enabled,
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

  const body = await request.json();
  const { name, description, prompt, systemPrompt, toolConfig, modelId, thinkingLevel, enabled } =
    body;

  // Normalize modelId format
  let resolvedModelId = existing.modelId;
  if (modelId !== undefined) {
    const raw = modelId || null;
    resolvedModelId = raw?.includes("/") ? raw.replace("/", ":") : raw;
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
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    },
  });

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
      enabled: updated.enabled,
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

  await prisma.agentDefinition.delete({ where: { id } });

  return NextResponse.json({ deleted: true, id });
}
