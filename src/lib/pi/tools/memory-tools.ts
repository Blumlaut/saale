import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

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
  ];
}
