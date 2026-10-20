import { prisma } from "@/lib/db";
import type { Memory, Prisma } from "@prisma/client";

/**
 * Shared persistence for the memory store.
 *
 * The settings API routes and the AI memory tools write the same rows, so the
 * normalisation and user scoping live here rather than in each caller.
 * Every read and write is scoped to `userId`.
 */

export interface MemoryDraft {
  collection: string;
  title: string;
  content: string;
  tags?: string[] | undefined;
}

export interface MemoryPatch {
  collection?: string | undefined;
  title?: string | undefined;
  content?: string | undefined;
  tags?: string[] | undefined;
}

export interface SerializedMemory {
  id: string;
  collection: string;
  title: string;
  content: string;
  tags: string[];
  source: string | null;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Collections are keys — case and padding must not split one into two. */
export function normalizeCollection(collection: string): string {
  return collection.trim().toLowerCase();
}

/** Trim, lowercase and de-duplicate tags so filters and counts stay consistent. */
export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const unique = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag) unique.add(tag);
  }
  return [...unique];
}

/** The single shape a memory takes on the wire (routes and tools). */
export function serializeMemory(memory: Memory): SerializedMemory {
  return {
    id: memory.id,
    collection: memory.collection,
    title: memory.title,
    content: memory.content,
    tags: memory.tags,
    source: memory.source,
    accessCount: memory.accessCount,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

/** Fetch a memory by id, or null when it does not belong to the user. */
export async function findMemory(userId: string, id: string): Promise<Memory | null> {
  return prisma.memory.findFirst({ where: { id, userId } });
}

/** Find a memory with the same title in a collection, ignoring case. */
export async function findMemoryByTitle(
  userId: string,
  collection: string,
  title: string,
): Promise<Memory | null> {
  return prisma.memory.findFirst({
    where: {
      userId,
      collection: normalizeCollection(collection),
      title: { equals: title.trim(), mode: "insensitive" },
    },
  });
}

export async function createMemory(userId: string, draft: MemoryDraft): Promise<Memory> {
  return prisma.memory.create({
    data: {
      userId,
      collection: normalizeCollection(draft.collection),
      title: draft.title.trim(),
      content: draft.content.trim(),
      tags: normalizeTags(draft.tags),
    },
  });
}

/**
 * Apply a partial update to a memory owned by the user.
 * Returns null when the id does not resolve to one of the user's memories.
 */
export async function updateMemory(
  userId: string,
  id: string,
  patch: MemoryPatch,
): Promise<Memory | null> {
  const existing = await findMemory(userId, id);
  if (!existing) return null;

  const data: Prisma.MemoryUpdateInput = {};
  if (patch.collection !== undefined) data.collection = normalizeCollection(patch.collection);
  if (patch.title !== undefined) data.title = patch.title.trim();
  if (patch.content !== undefined) data.content = patch.content.trim();
  if (patch.tags !== undefined) data.tags = normalizeTags(patch.tags);

  // Nothing to change — skip the write rather than bumping updatedAt.
  if (Object.keys(data).length === 0) return existing;

  return prisma.memory.update({ where: { id, userId }, data });
}

/** Delete a memory owned by the user. Returns false when nothing matched. */
export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const result = await prisma.memory.deleteMany({ where: { id, userId } });
  return result.count > 0;
}
