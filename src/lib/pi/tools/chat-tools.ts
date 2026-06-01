import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";

/**
 * Create a chat search tool with userId injection.
 * Returns a factory function that creates the tool with the userId baked in.
 */
export function createChatSearchTool(userId: string) {
  return defineTool({
    name: "chat_search",
    label: "Search Chat History",
    description: "Search through chat history by query. Returns matching sessions and messages.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query to match against chat messages.",
      }),
      limit: Type.Optional(
        Type.Integer({
          description: "Maximum number of results. Default: 20.",
          default: 20,
        }),
      ),
    }),
    execute: async (_toolCallId: string, params: { query: string; limit?: number }) => {
      const query = params.query.toLowerCase();
      const limit = params.limit ?? 20;

      // Search across all chat sessions for this user
      const sessions = await prisma.chatSession.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        include: {
          messages: {
            orderBy: { createdAt: "desc" },
            take: 50,
          },
        },
      });

      const results: Array<{
        sessionId: string;
        sessionTitle: string;
        messageId: string;
        role: string;
        content: string;
        date: string;
      }> = [];

      for (const session of sessions) {
        for (const message of session.messages) {
          if (message.content.toLowerCase().includes(query)) {
            results.push({
              sessionId: session.id,
              sessionTitle: session.title,
              messageId: message.id,
              role: message.role,
              content: message.content.slice(0, 300),
              date: message.createdAt.toISOString(),
            });

            if (results.length >= limit) {
              break;
            }
          }
        }

        if (results.length >= limit) {
          break;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query: params.query,
                count: results.length,
                results,
              },
              null,
              2,
            ),
          },
        ],
        details: { count: results.length },
      };
    },
  });
}
