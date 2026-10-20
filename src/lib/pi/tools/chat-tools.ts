import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { deleteChatSession } from "@/lib/chat/delete-session";
import { readWorkspaceFile } from "@/lib/files/workspace-file";

/**
 * Create a chat search tool with userId injection.
 * Returns a factory function that creates the tool with the userId baked in.
 */
/** One matching message, with the chat it came from. */
const CHAT_HIT_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionTitle: Type.String(),
  messageId: Type.String(),
  role: Type.String(),
  content: Type.String(),
  date: Type.String(),
});

const CHAT_SEARCH_SCHEMA = Type.Object({
  query: Type.String(),
  count: Type.Integer(),
  results: Type.Array(CHAT_HIT_SCHEMA),
});

/** The reply a chat gave when something was said in it. */
const CHAT_REPLY_SCHEMA = Type.Object({
  sessionId: Type.String(),
  title: Type.String(),
  reply: Type.String(),
});

/** A new chat, plus what it answered. */
const CHAT_STARTED_SCHEMA = Type.Object({
  ...CHAT_REPLY_SCHEMA.properties,
  started: Type.Boolean(),
});

const CHAT_DELETED_SCHEMA = Type.Object({
  deleted: Type.Boolean(),
  sessionId: Type.String(),
  title: Type.String(),
});

/**
 * Name of the file-sharing tool, shared so a delivery channel can recognise the
 * call whose file it has to carry to the user itself.
 */
export const SHOW_FILE_TOOL_NAME = "show_file";

/** A file shared into the chat. */
const SHARED_FILE_SCHEMA = Type.Object({
  fileName: Type.String(),
  size: Type.Integer(),
  mimeType: Type.String(),
  kind: Type.Union([Type.Literal("image"), Type.Literal("file")]),
});

export function createChatSearchTool(userId: string) {
  return defineStructuredTool({
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
    outputSchema: CHAT_SEARCH_SCHEMA,
    execute: async (_toolCallId: string, params: { query: string; limit?: number }) => {
      const searchQuery = params.query.trim();
      const limit = Math.min(params.limit ?? 20, 100);

      // Use PostgreSQL full-text search for efficient, ranked results.
      // Joins ChatSession + ChatMessage, searches both title and content.
      const results = await prisma.$queryRaw<
        Array<{
          sessionId: string;
          sessionTitle: string;
          messageId: string;
          role: string;
          content: string;
          date: string;
          rank: number;
        }>
      >(
        Prisma.sql`
          SELECT
            "ChatSession".id AS "sessionId",
            "ChatSession".title AS "sessionTitle",
            "ChatMessage".id AS "messageId",
            "ChatMessage".role,
            LEFT("ChatMessage".content, 300) AS content,
            "ChatMessage"."createdAt"::text AS date,
            ts_rank(
              to_tsvector('english', COALESCE("ChatMessage".content, '')),
              plainto_tsquery('english', ${searchQuery})
            ) AS rank
          FROM "ChatMessage"
          JOIN "ChatSession" ON "ChatMessage"."sessionId" = "ChatSession".id
          WHERE "ChatSession"."userId" = ${userId}
            AND to_tsvector('english', COALESCE("ChatMessage".content, '')) @@ plainto_tsquery('english', ${searchQuery})
          ORDER BY rank DESC
          LIMIT ${limit}
        `,
      );

      return {
        value: {
          query: params.query,
          count: results.length,
          results: results.map((r) => ({
            sessionId: r.sessionId,
            sessionTitle: r.sessionTitle,
            messageId: r.messageId,
            role: r.role,
            content: r.content,
            date: r.date,
          })),
        },
        details: { count: results.length },
      };
    },
  });
}

/**
 * Create the chat tools: history search plus the two write operations on a
 * chat. respond in it, and delete it.
 *
 * The write tools default to the `ask` approval policy (see `tool-infos.ts`):
 * one starts an agent run in another conversation, the other destroys one.
 *
 * @param sessionId - The chat this tool set belongs to. `chat_respond` must
 *   never target it: a session cannot be prompted while it is already running.
 */
export function createChatTools(userId: string, sessionId: string): ToolDefinition[] {
  return [
    createChatSearchTool(userId),
    createChatRespondTool(userId, sessionId),
    createChatCreateTool(userId, sessionId),
    createChatDeleteTool(userId),
  ];
}

/**
 * Respond in another chat: post a message there as the user and run that
 * chat's agent, returning its reply.
 *
 * The run happens server-side (see `respond-in-chat.ts`). it does not need a
 * client to be connected. and streams to any client that has the chat open.
 * The import is dynamic on purpose: the run builder reaches back through
 * `chat-session-factory` into this module (tools are resolved while a session
 * is built), so a static import would close a module cycle at startup.
 */
export function createChatRespondTool(userId: string, callerSessionId: string) {
  return defineStructuredTool({
    name: "chat_respond",
    label: "Respond in Chat",
    description:
      "Send a message into one of the user's other chats as the user, then " +
      "wait for that chat's assistant to reply. Use the sessionId from " +
      "chat_search. Runs that chat's agent. use it to hand work to another " +
      "conversation or to keep a discussion going there.",
    parameters: Type.Object({
      sessionId: Type.String({
        description: "Chat session ID to respond in, as returned by chat_search.",
      }),
      message: Type.String({
        description: "The message to send to that chat.",
      }),
    }),
    outputSchema: CHAT_REPLY_SCHEMA,
    execute: async (
      _toolCallId: string,
      params: { sessionId: string; message: string },
      signal: AbortSignal | undefined,
    ) => {
      const { respondInChat } = await import("@/lib/chat/respond-in-chat");
      const result = await respondInChat({
        userId,
        sessionId: params.sessionId,
        callerSessionId,
        message: params.message,
        signal,
      });

      return {
        value: {
          sessionId: result.sessionId,
          title: result.title,
          reply: result.reply,
        },
        text: `Chat \"${result.title}\" replied:\n\n${result.reply || "(no reply)"}`,
        details: { sessionId: result.sessionId, title: result.title, reply: result.reply },
      };
    },
  });
}

/**
 * Start a new chat and take its first reply: create the chat, post the message
 * as the user, and run its agent. the same server-side run as `chat_respond`.
 *
 * Both imports are dynamic for the same reason as `chat_respond`'s.
 */
export function createChatCreateTool(userId: string, callerSessionId: string) {
  return defineStructuredTool({
    name: "chat_create",
    label: "Start Chat",
    description:
      "Start a new chat with a message and wait for the assistant's reply " +
      "there. Use it to open a separate conversation for a task instead of " +
      "doing the work in the current chat.",
    parameters: Type.Object({
      message: Type.String({ description: "The first message to send in the new chat." }),
      title: Type.Optional(Type.String({ description: "Optional short title for the new chat." })),
    }),
    outputSchema: CHAT_STARTED_SCHEMA,
    execute: async (
      _toolCallId: string,
      params: { message: string; title?: string },
      signal: AbortSignal | undefined,
    ) => {
      const [{ createChatSessionRow }, { respondInChat }] = await Promise.all([
        import("@/lib/chat/create-session"),
        import("@/lib/chat/respond-in-chat"),
      ]);

      const session = await createChatSessionRow(userId, { title: params.title });
      const result = await respondInChat({
        userId,
        sessionId: session.id,
        callerSessionId,
        message: params.message,
        signal,
      });

      return {
        value: {
          started: true,
          sessionId: result.sessionId,
          title: result.title,
          reply: result.reply,
        },
        text:
          `Started chat "${result.title}" (${result.sessionId}). it replied:\n\n` +
          (result.reply || "(no reply)"),
        details: { sessionId: result.sessionId, title: result.title, reply: result.reply },
      };
    },
  });
}

/**
 * Permanently delete one of the user's chats, with all of its messages and
 * attachments. Delegates to the same helper the delete route uses.
 */
export function createChatDeleteTool(userId: string) {
  return defineStructuredTool({
    name: "chat_delete",
    label: "Delete Chat",
    description:
      "Permanently delete one of the user's chats and all of its messages, " +
      "attachments, and any watchers attached to it. This cannot be undone. " +
      "Use the sessionId from chat_search.",
    parameters: Type.Object({
      sessionId: Type.String({
        description: "Chat session ID, as returned by chat_search.",
      }),
    }),
    outputSchema: CHAT_DELETED_SCHEMA,
    execute: async (_toolCallId: string, params: { sessionId: string }) => {
      const { title } = await deleteChatSession(userId, params.sessionId);

      return {
        value: { deleted: true, sessionId: params.sessionId, title },
        text: `Deleted chat "${title}" (${params.sessionId}) and everything attached to it.`,
        details: { sessionId: params.sessionId, title },
      };
    },
  });
}

/**
 * Create a show_file tool that hands a file from the user's workspace to the
 * chat, where it renders inline (images) or as a download link.
 *
 * Only enabled when bash tools are active (implies workspace access). When
 * terminal is configured, reads through the Open Terminal API.
 */
export function createShowFileTool(userId: string, sessionId: string) {
  return defineStructuredTool({
    name: SHOW_FILE_TOOL_NAME,
    label: "Show File",
    description:
      "Send a file from the workspace to the user in the chat. the only way they can receive one, " +
      "since they have no access to the workspace filesystem themselves. Send anything they asked " +
      "for, including a file you just created or changed. Images are shown inline; every other " +
      "type, known or not, is delivered as-is. Path is relative to the workspace root. " +
      "Max file size: 50MB.",
    parameters: Type.Object({
      filePath: Type.String({
        description: "Path to the file, relative to the workspace root.",
      }),
      description: Type.Optional(
        Type.String({
          description: "Optional description of what this file is.",
        }),
      ),
    }),
    outputSchema: SHARED_FILE_SCHEMA,
    execute: async (_toolCallId: string, params: { filePath: string; description?: string }) => {
      const { filePath, description } = params;
      const { fileName, size, mimeType } = await readWorkspaceFile(userId, filePath, { sessionId });

      const sizeLabel =
        size > 1024 * 1024
          ? `${(size / 1024 / 1024).toFixed(1)} MB`
          : size > 1024
            ? `${(size / 1024).toFixed(0)} KB`
            : `${size} B`;

      const typeLabel: "image" | "file" = mimeType.startsWith("image/") ? "image" : "file";
      const prefix = description ? `${description}. ` : "";

      return {
        value: { fileName, size, mimeType, kind: typeLabel },
        text: `${prefix}Shared ${typeLabel} "${fileName}" (${sizeLabel}).`,
        details: { fileName, size, mimeType },
      };
    },
  });
}
