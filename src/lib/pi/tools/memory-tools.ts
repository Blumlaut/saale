import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  createMemory,
  deleteMemory,
  findMemory,
  findMemoryByTitle,
  serializeMemory,
  updateMemory,
} from "@/lib/memory/store";

/**
 * Create memory tools with userId injection for user isolation.
 * All queries are scoped to the authenticated user's memories.
 * Returns an array of tool definitions for direct spread into the agent session.
 */
export function createMemoryTools(userId: string): ToolDefinition[] {
  return [
    // ─── memory_index ───────────────────────────────────────────────────

    defineTool({
      name: "memory_index",
      label: "Memory Index",
      description:
        "List all available memory collections with their sizes, top tags, and recent memory titles. Use this BEFORE searching to understand what knowledge is available.",
      parameters: Type.Object({}),
      execute: async (_toolCallId) => {
        // Get collections with counts and top tags
        const collections = await prisma.memory.groupBy({
          by: ["collection"],
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
          where: { userId },
        });

        const details = await Promise.all(
          collections.map(async (c) => {
            // Get top tags for this collection
            const tagResults = await prisma.$queryRaw<Array<{ tag: string; count: number }>>(
              Prisma.sql`
                SELECT UNNEST(tags) AS tag, COUNT(*) AS count
                FROM "Memory"
                WHERE "userId" = ${userId} AND collection = ${c.collection}
                GROUP BY tag
                ORDER BY count DESC
                LIMIT 5
              `,
            );

            // Get 3 most recent memory titles
            const recent = await prisma.memory.findMany({
              where: { userId, collection: c.collection },
              orderBy: { updatedAt: "desc" },
              take: 3,
              select: { title: true },
            });

            return {
              collection: c.collection,
              count: c._count.id,
              topTags: tagResults.map((t) => t.tag),
              recent: recent.map((r) => r.title),
            };
          }),
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  totalCollections: details.length,
                  totalMemories: details.reduce((sum, d) => sum + d.count, 0),
                  collections: details,
                },
                null,
                2,
              ),
            },
          ],
          details: { collections: details.length },
        };
      },
    }),

    // ─── memory_search ──────────────────────────────────────────────────

    defineTool({
      name: "memory_search",
      label: "Search Memory",
      description:
        "Search the persistent memory store for facts, decisions, preferences, and other knowledge extracted from past conversations.",
      parameters: Type.Object({
        query: Type.String({
          description: "Search query — use natural language or keywords.",
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
              description: "Filter by tags — returns memories matching any of the given tags.",
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
      execute: async (_toolCallId, params) => {
        const limit = Math.min(params.limit ?? 10, 50);
        const searchQuery = params.query.trim();
        const collectionFilter = params.collection;
        const tagsFilter = params.tags;

        // Guard: empty/whitespace queries would produce an empty tsquery matching everything
        if (!searchQuery) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ count: 0, memories: [], error: "Query is empty" }, null, 2),
              },
            ],
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
          importance: number;
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
              importance: number;
              accessCount: number;
              createdAt: Date;
              updatedAt: Date;
              rank: number;
            }>
          >(
            Prisma.sql`
              SELECT id, collection, title, content, tags, importance, "accessCount", "createdAt", "updatedAt",
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
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: results.length,
                  memories: results.map((r) => ({
                    id: r.id,
                    collection: r.collection,
                    title: r.title,
                    content: r.content,
                    tags: r.tags,
                    importance: r.importance,
                    accessCount: r.accessCount,
                    createdAt: r.createdAt.toISOString(),
                    updatedAt: r.updatedAt.toISOString(),
                  })),
                },
                null,
                2,
              ),
            },
          ],
          details: { count: results.length },
        };
      },
    }),

    // ─── memory_create ──────────────────────────────────────────────────

    defineTool({
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
        importance: Type.Optional(
          Type.Integer({
            description: "1-10; explicit user statements are 7-10. Default: 5.",
          }),
        ),
      }),
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
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    created: false,
                    reason:
                      "A memory with this title already exists in that collection — update it instead of creating a duplicate.",
                    memory: serializeMemory(existing),
                  },
                  null,
                  2,
                ),
              },
            ],
            details: { id: existing.id, created: false },
          };
        }

        const memory = await createMemory(userId, {
          collection,
          title,
          content,
          tags: params.tags,
          importance: params.importance,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ created: true, memory: serializeMemory(memory) }, null, 2),
            },
          ],
          details: { id: memory.id, created: true },
        };
      },
    }),

    // ─── memory_update ──────────────────────────────────────────────────

    defineTool({
      name: "memory_update",
      label: "Update Memory",
      description:
        "Correct or extend an existing memory by ID. Get IDs from memory_search or memory_index. Only the fields you pass are changed — content replaces the old text, it is not appended.",
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
        importance: Type.Optional(Type.Integer({ description: "1-10." })),
      }),
      execute: async (_toolCallId, params) => {
        const patch = {
          collection: params.collection,
          title: params.title,
          content: params.content,
          tags: params.tags,
          importance: params.importance,
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
          content: [
            {
              type: "text",
              text: JSON.stringify({ updated: true, memory: serializeMemory(memory) }, null, 2),
            },
          ],
          details: { id: memory.id },
        };
      },
    }),

    // ─── memory_delete ──────────────────────────────────────────────────

    defineTool({
      name: "memory_delete",
      label: "Delete Memory",
      description:
        "Permanently delete a memory by its ID. Get IDs from memory_search or memory_index.",
      parameters: Type.Object({
        id: Type.String({
          description: "Memory ID to delete.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const memory = await findMemory(userId, params.id);

        if (!memory) {
          throw new Error(`Memory ${params.id} not found`);
        }

        // Defense in depth: scope the delete to the owner even though the
        // record was fetched with the same guard.
        await deleteMemory(userId, params.id);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  deleted: true,
                  id: memory.id,
                  title: memory.title,
                  collection: memory.collection,
                },
                null,
                2,
              ),
            },
          ],
          details: { id: memory.id },
        };
      },
    }),
  ];
}
