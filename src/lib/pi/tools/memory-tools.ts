import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import {
  createMemory,
  deleteMemory,
  findMemory,
  findMemoryByTitle,
  serializeMemory,
  updateMemory,
} from "@/lib/memory/store";

/** A memory as every memory tool reports it. */
const memorySchema = Type.Object({
  id: Type.String(),
  collection: Type.String(),
  title: Type.String(),
  content: Type.String(),
  tags: Type.Array(Type.String()),
  // Absent from search results: the full-text query does not select it.
  source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  accessCount: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

/** Collections with their sizes, for the index. */
const memoryIndexSchema = Type.Object({
  totalCollections: Type.Integer(),
  totalMemories: Type.Integer(),
  collections: Type.Array(
    Type.Object({
      collection: Type.String(),
      count: Type.Integer(),
      topTags: Type.Array(Type.String()),
      recent: Type.Array(Type.String()),
    }),
  ),
});

/** Search results, or the reason there are none. */
const memorySearchSchema = Type.Object({
  count: Type.Integer(),
  memories: Type.Array(memorySchema),
  error: Type.Optional(Type.String()),
});

/** The save outcome: a new memory, or the one that already held that title. */
const memoryCreateSchema = Type.Object({
  created: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  memory: memorySchema,
});

const memoryUpdateSchema = Type.Object({ updated: Type.Boolean(), memory: memorySchema });

const memoryDeleteSchema = Type.Object({
  deleted: Type.Boolean(),
  id: Type.String(),
  title: Type.String(),
  collection: Type.String(),
});

/**
 * Create memory tools with userId injection for user isolation.
 * All queries are scoped to the authenticated user's memories.
 * Returns an array of tool definitions for direct spread into the agent session.
 */
export function createMemoryTools(userId: string): ToolDefinition[] {
  return [
    // ─── memory_index ───────────────────────────────────────────────────

    defineStructuredTool({
      name: "memory_index",
      label: "Memory Index",
      description:
        "List all available memory collections with their sizes, top tags, and recent memory titles. Use this BEFORE searching to understand what knowledge is available.",
      parameters: Type.Object({}),
      outputSchema: memoryIndexSchema,
      execute: async (_toolCallId) => {
        // Get collections with counts and top tags
        const collections = await prisma.memory.groupBy({
          by: ["collection"],
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
          where: { userId },
        });

        // Batch top tags across all collections in one query
        const tagRows = collections.length
          ? await prisma.$queryRaw<Array<{ collection: string; tag: string; count: number }>>(
              Prisma.sql`
                SELECT collection, UNNEST(tags) AS tag, COUNT(*)::int AS count
                FROM "Memory"
                WHERE "userId" = ${userId}
                GROUP BY collection, tag
                ORDER BY collection, count DESC
              `,
            )
          : [];

        const topTagsByCollection = new Map<string, string[]>();
        for (const row of tagRows) {
          const list = topTagsByCollection.get(row.collection) ?? [];
          if (list.length < 5) list.push(row.tag);
          topTagsByCollection.set(row.collection, list);
        }

        // Batch recent titles across all collections in one query
        const recentRows = collections.length
          ? await prisma.memory.findMany({
              where: { userId, collection: { in: collections.map((c) => c.collection) } },
              orderBy: [{ collection: "asc" }, { updatedAt: "desc" }],
              select: { collection: true, title: true },
            })
          : [];
        const recentByCollection = new Map<string, string[]>();
        for (const row of recentRows) {
          const list = recentByCollection.get(row.collection) ?? [];
          if (list.length < 3) list.push(row.title);
          recentByCollection.set(row.collection, list);
        }

        const details = collections.map((c) => ({
          collection: c.collection,
          count: c._count.id,
          topTags: topTagsByCollection.get(c.collection) ?? [],
          recent: recentByCollection.get(c.collection) ?? [],
        }));

        return {
          value: {
            totalCollections: details.length,
            totalMemories: details.reduce((sum, d) => sum + d.count, 0),
            collections: details,
          },
          details: { collections: details.length },
        };
      },
    }),

    // ─── memory_search ──────────────────────────────────────────────────

    defineStructuredTool({
      name: "memory_search",
      label: "Search Memory",
      description:
        "Search the persistent memory store for facts, decisions, preferences, and other knowledge extracted from past conversations.",
      parameters: Type.Object({
        query: Type.String({
          description: "Search query. use natural language or keywords.",
        }),
        collection: Type.Optional(
          Type.String({
            description:
              "Filter by collection (e.g. 'facts', 'projects', 'people', 'preferences', 'decisions').",
          }),
        ),
        tags: Type.Optional(
          Type.Array(
            Type.String({
              description: "Filter by tags. returns memories matching any of the given tags.",
            }),
          ),
        ),
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum number of results. Default: 10.",
            default: 10,
          }),
        ),
      }),
      outputSchema: memorySearchSchema,
      execute: async (_toolCallId, params) => {
        const limit = Math.min(params.limit ?? 10, 50);
        const searchQuery = params.query.trim();
        const collectionFilter = params.collection;
        const tagsFilter = params.tags;

        // Guard: empty/whitespace queries would produce an empty tsquery matching everything
        if (!searchQuery) {
          return {
            value: { count: 0, memories: [], error: "Query is empty" },
            details: { count: 0 },
          };
        }

        // Try full-text search first, fall back to simple contains on error
        let results: Array<{
          id: string;
          collection: string;
          title: string;
          content: string;
          tags: string[];
          accessCount: number;
          createdAt: Date;
          updatedAt: Date;
        }>;

        try {
          const ftsResults = await prisma.$queryRaw<
            Array<{
              id: string;
              collection: string;
              title: string;
              content: string;
              tags: string[];
              accessCount: number;
              createdAt: Date;
              updatedAt: Date;
              rank: number;
            }>
          >(
            Prisma.sql`
              SELECT id, collection, title, content, tags, "accessCount", "createdAt", "updatedAt",
                     ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE("content", '')), plainto_tsquery('english', ${searchQuery})) AS rank
              FROM "Memory"
              WHERE "userId" = ${userId}
                AND to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE("content", '')) @@ plainto_tsquery('english', ${searchQuery})
                ${collectionFilter ? Prisma.sql`AND collection = ${collectionFilter}` : Prisma.empty}
                ${
                  tagsFilter && tagsFilter.length > 0
                    ? Prisma.sql`AND tags && ${tagsFilter}::text[]`
                    : Prisma.empty
                }
              ORDER BY rank DESC
              LIMIT ${limit}
            `,
          );
          results = ftsResults;
        } catch (err) {
          console.error("memory_search FTS failed, falling back to contains:", err);

          // Fallback: simple case-insensitive contains search via Prisma ORM
          const where: Record<string, unknown> = {
            userId,
            OR: [
              { title: { contains: searchQuery, mode: "insensitive" } },
              { content: { contains: searchQuery, mode: "insensitive" } },
            ],
          };
          if (collectionFilter) where.collection = collectionFilter;
          if (tagsFilter && tagsFilter.length > 0) where.tags = { hasSome: tagsFilter };

          results = await prisma.memory.findMany({
            where,
            orderBy: { updatedAt: "desc" },
            take: limit,
          });
        }

        // Increment accessCount for returned memories (bulk update, scoped to user)
        const memoryIds = results.map((r) => r.id);
        if (memoryIds.length > 0) {
          await prisma.memory.updateMany({
            where: { id: { in: memoryIds }, userId },
            data: { accessCount: { increment: 1 } },
          });
        }

        return {
          value: {
            count: results.length,
            memories: results.map((r) => ({
              id: r.id,
              collection: r.collection,
              title: r.title,
              content: r.content,
              tags: r.tags,
              accessCount: r.accessCount,
              createdAt: r.createdAt.toISOString(),
              updatedAt: r.updatedAt.toISOString(),
            })),
          },
          details: { count: results.length },
        };
      },
    }),

    // ─── memory_create ──────────────────────────────────────────────────

    defineStructuredTool({
      name: "memory_create",
      label: "Save Memory",
      description:
        "Save a durable fact, preference, decision or project detail to the persistent memory store. Use this when the user states something worth remembering long-term. Do not save transient troubleshooting steps, job configuration or workflow instructions. If a memory with the same title already exists in the collection, this reports the existing memory instead of duplicating it.",
      parameters: Type.Object({
        collection: Type.String({
          description:
            "Category for the memory, e.g. 'facts', 'preferences', 'projects', 'people', 'decisions'. Reuse an existing collection when one fits (see memory_index).",
        }),
        title: Type.String({
          description: "Short, specific title for the memory.",
        }),
        content: Type.String({
          description: "The memory itself, written as a self-contained fact.",
        }),
        tags: Type.Optional(
          Type.Array(Type.String({ description: "Free-form tag for retrieval." })),
        ),
      }),
      outputSchema: memoryCreateSchema,
      execute: async (_toolCallId, params) => {
        const collection = params.collection.trim();
        const title = params.title.trim();
        const content = params.content.trim();

        if (!collection || !title || !content) {
          throw new Error("collection, title and content are required");
        }

        const existing = await findMemoryByTitle(userId, collection, title);
        if (existing) {
          return {
            value: {
              created: false,
              reason:
                "A memory with this title already exists in that collection. update it instead of creating a duplicate.",
              memory: serializeMemory(existing),
            },
            details: { id: existing.id, created: false },
          };
        }

        const memory = await createMemory(userId, {
          collection,
          title,
          content,
          tags: params.tags,
        });

        return {
          value: { created: true, memory: serializeMemory(memory) },
          details: { id: memory.id, created: true },
        };
      },
    }),

    // ─── memory_update ──────────────────────────────────────────────────

    defineStructuredTool({
      name: "memory_update",
      label: "Update Memory",
      description:
        "Correct or extend an existing memory by ID. Get IDs from memory_search or memory_index. Only the fields you pass are changed. content replaces the old text, it is not appended.",
      parameters: Type.Object({
        id: Type.String({
          description: "Memory ID to update.",
        }),
        collection: Type.Optional(
          Type.String({ description: "Move the memory to another collection." }),
        ),
        title: Type.Optional(Type.String({ description: "New title." })),
        content: Type.Optional(Type.String({ description: "Replacement content." })),
        tags: Type.Optional(Type.Array(Type.String({ description: "Replacement tag list." }))),
      }),
      outputSchema: memoryUpdateSchema,
      execute: async (_toolCallId, params) => {
        const patch = {
          collection: params.collection,
          title: params.title,
          content: params.content,
          tags: params.tags,
        };

        if (Object.values(patch).every((value) => value === undefined)) {
          throw new Error("Provide at least one field to update");
        }
        for (const key of ["collection", "title", "content"] as const) {
          const value = patch[key];
          if (value !== undefined && !value.trim()) {
            throw new Error(`${key} cannot be empty`);
          }
        }

        const memory = await updateMemory(userId, params.id, patch);
        if (!memory) {
          throw new Error(`Memory ${params.id} not found`);
        }

        return {
          value: { updated: true, memory: serializeMemory(memory) },
          details: { id: memory.id },
        };
      },
    }),

    // ─── memory_delete ──────────────────────────────────────────────────

    defineStructuredTool({
      name: "memory_delete",
      label: "Delete Memory",
      description:
        "Permanently delete a memory by its ID. Get IDs from memory_search or memory_index.",
      parameters: Type.Object({
        id: Type.String({
          description: "Memory ID to delete.",
        }),
      }),
      outputSchema: memoryDeleteSchema,
      execute: async (_toolCallId, params) => {
        const memory = await findMemory(userId, params.id);

        if (!memory) {
          throw new Error(`Memory ${params.id} not found`);
        }

        // Defense in depth: scope the delete to the owner even though the
        // record was fetched with the same guard.
        await deleteMemory(userId, params.id);

        return {
          value: {
            deleted: true,
            id: memory.id,
            title: memory.title,
            collection: memory.collection,
          },
          details: { id: memory.id },
        };
      },
    }),
  ];
}
