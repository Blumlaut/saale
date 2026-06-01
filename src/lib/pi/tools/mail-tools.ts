import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { sendEmail } from "@/lib/email/smtp";

// ─── mail_list ───────────────────────────────────────────────────────────────

export const mailListTool = defineTool({
  name: "mail_list",
  label: "List Emails",
  description:
    "List emails from connected email accounts. Supports filtering by folder, read/unread status, date range, and pagination.",
  parameters: Type.Object({
    accountId: Type.Optional(
      Type.String({
        description: "Filter by email account ID. Omit to search across all accounts.",
      }),
    ),
    folder: Type.Optional(
      Type.String({
        description: 'Filter by folder (e.g. "INBOX", "Sent", "Trash", "Drafts").',
      }),
    ),
    unread: Type.Optional(
      Type.Boolean({
        description: "If true, only return unread emails.",
      }),
    ),
    starred: Type.Optional(
      Type.Boolean({
        description: "If true, only return starred emails.",
      }),
    ),
    since: Type.Optional(
      Type.String({
        description: "ISO date string. Only return emails on or after this date.",
      }),
    ),
    until: Type.Optional(
      Type.String({
        description: "ISO date string. Only return emails before this date.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Maximum number of emails to return. Default: 20.",
        default: 20,
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        description: "Number of emails to skip for pagination. Default: 0.",
        default: 0,
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    const where: Record<string, unknown> = {};

    if (params.accountId) {
      where.accountId = params.accountId;
    }
    if (params.folder) {
      where.folder = params.folder;
    }
    if (params.unread !== undefined) {
      where.isRead = !params.unread;
    }
    if (params.starred !== undefined) {
      where.isStarred = params.starred;
    }
    if (params.since) {
      where.date = where.date || {};
      (where.date as Record<string, unknown>).gte = new Date(params.since);
    }
    if (params.until) {
      where.date = where.date || {};
      (where.date as Record<string, unknown>).lt = new Date(params.until);
    }

    const emails = await prisma.emailMessage.findMany({
      where,
      orderBy: { date: "desc" },
      take: params.limit ?? 20,
      skip: params.offset ?? 0,
      select: {
        id: true,
        uid: true,
        fromName: true,
        fromEmail: true,
        to: true,
        subject: true,
        date: true,
        bodyPreview: true,
        isRead: true,
        isStarred: true,
        folder: true,
        tags: true,
        accountId: true,
      },
    });

    const total = await prisma.emailMessage.count({ where });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: emails.length,
              total,
              hasMore: emails.length < total - (params.offset ?? 0),
              emails: emails.map(
                (e: {
                  id: string;
                  uid: string;
                  fromName: string | null;
                  fromEmail: string;
                  to: string;
                  subject: string;
                  date: Date;
                  bodyPreview: string;
                  isRead: boolean;
                  isStarred: boolean;
                  folder: string;
                  tags: string[];
                }) => ({
                  id: e.id,
                  uid: e.uid,
                  from: e.fromName ? `${e.fromName} <${e.fromEmail}>` : e.fromEmail,
                  to: e.to,
                  subject: e.subject,
                  date: e.date.toISOString(),
                  preview: e.bodyPreview.slice(0, 200),
                  read: e.isRead,
                  starred: e.isStarred,
                  folder: e.folder,
                  tags: e.tags,
                }),
              ),
            },
            null,
            2,
          ),
        },
      ],
      details: { count: emails.length, total },
    };
  },
});

// ─── mail_read ───────────────────────────────────────────────────────────────

export const mailReadTool = defineTool({
  name: "mail_read",
  label: "Read Email(s)",
  description:
    "Read full content of one or more emails by their IDs. Accepts an array of email IDs.",
  parameters: Type.Object({
    ids: Type.Array(
      Type.String({
        description: "Email message ID(s) to read.",
      }),
      {
        minItems: 1,
        maxItems: 20,
      },
    ),
  }),
  execute: async (_toolCallId, params) => {
    const emails = await prisma.emailMessage.findMany({
      where: {
        id: { in: params.ids },
      },
      select: {
        id: true,
        fromName: true,
        fromEmail: true,
        to: true,
        subject: true,
        date: true,
        bodyHtml: true,
        bodyText: true,
        bodyPreview: true,
        isRead: true,
        isStarred: true,
        folder: true,
        tags: true,
        aiSummary: true,
        aiTags: true,
        spamScore: true,
      },
    });

    // Mark as read
    if (emails.length > 0) {
      await prisma.emailMessage.updateMany({
        where: { id: { in: params.ids } },
        data: { isRead: true },
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            emails.map(
              (e: {
                id: string;
                fromName: string | null;
                fromEmail: string;
                to: string;
                subject: string;
                date: Date;
                bodyText: string | null;
                bodyHtml: string | null;
                bodyPreview: string;
                isRead: boolean;
                isStarred: boolean;
                folder: string;
                tags: string[];
                aiSummary: string | null;
                aiTags: string[];
                spamScore: number | null;
              }) => ({
                id: e.id,
                from: e.fromName ? `${e.fromName} <${e.fromEmail}>` : e.fromEmail,
                to: e.to,
                subject: e.subject,
                date: e.date.toISOString(),
                bodyText: e.bodyText ?? e.bodyPreview,
                bodyHtml: e.bodyHtml,
                read: e.isRead,
                starred: e.isStarred,
                folder: e.folder,
                tags: e.tags,
                aiSummary: e.aiSummary,
                aiTags: e.aiTags,
                spamScore: e.spamScore,
              }),
            ),
            null,
            2,
          ),
        },
      ],
      details: { count: emails.length },
    };
  },
});

// ─── mail_search ─────────────────────────────────────────────────────────────

export const mailSearchTool = defineTool({
  name: "mail_search",
  label: "Search Emails",
  description:
    "Search emails across all connected accounts using PostgreSQL full-text search. Searches subject, body, and sender.",
  parameters: Type.Object({
    query: Type.String({
      description: "Search query (free text).",
    }),
    accountId: Type.Optional(
      Type.String({
        description: "Filter by email account ID.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Maximum results. Default: 20.",
        default: 20,
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    const where: Record<string, unknown> = {
      OR: [
        { subject: { contains: params.query, mode: "insensitive" } },
        { bodyText: { contains: params.query, mode: "insensitive" } },
        { bodyPreview: { contains: params.query, mode: "insensitive" } },
        { fromEmail: { contains: params.query, mode: "insensitive" } },
        { fromName: { contains: params.query, mode: "insensitive" } },
      ],
    };

    if (params.accountId) {
      where.accountId = params.accountId;
    }

    const emails = await prisma.emailMessage.findMany({
      where,
      orderBy: { date: "desc" },
      take: params.limit ?? 20,
      select: {
        id: true,
        fromName: true,
        fromEmail: true,
        subject: true,
        date: true,
        bodyPreview: true,
        isRead: true,
        folder: true,
        accountId: true,
      },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query: params.query,
              count: emails.length,
              emails: emails.map(
                (e: {
                  id: string;
                  fromName: string | null;
                  fromEmail: string;
                  subject: string;
                  date: Date;
                  bodyPreview: string;
                  isRead: boolean;
                  folder: string;
                }) => ({
                  id: e.id,
                  from: e.fromName ? `${e.fromName} <${e.fromEmail}>` : e.fromEmail,
                  subject: e.subject,
                  date: e.date.toISOString(),
                  preview: e.bodyPreview.slice(0, 200),
                  read: e.isRead,
                  folder: e.folder,
                }),
              ),
            },
            null,
            2,
          ),
        },
      ],
      details: { count: emails.length },
    };
  },
});

// ─── mail_send ───────────────────────────────────────────────────────────────

export const mailSendTool = defineTool({
  name: "mail_send",
  label: "Send Email",
  description: "Send an email via SMTP using the user's configured email account.",
  parameters: Type.Object({
    accountId: Type.String({
      description: "The email account ID to send from.",
    }),
    to: Type.Array(
      Type.String({
        description: "Recipient email address(es).",
      }),
      { minItems: 1 },
    ),
    subject: Type.String({
      description: "Email subject line.",
    }),
    body: Type.String({
      description: "Email body (plain text).",
    }),
    bodyHtml: Type.Optional(
      Type.String({
        description: "Optional HTML body. Falls back to plain text body if not provided.",
      }),
    ),
    replyTo: Type.Optional(
      Type.String({
        description: "Optional reply-to email address.",
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    const account = await prisma.emailAccount.findUnique({
      where: { id: params.accountId },
    });

    if (!account) {
      throw new Error(`Email account ${params.accountId} not found`);
    }

    const password = decrypt(account.encryptedPassword);

    const result = await sendEmail({
      account,
      password,
      to: params.to,
      subject: params.subject,
      body: params.body,
      ...(params.bodyHtml ? { bodyHtml: params.bodyHtml } : {}),
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sent: true,
              messageId: result.messageId,
              to: params.to,
              subject: params.subject,
            },
            null,
            2,
          ),
        },
      ],
      details: { messageId: result.messageId },
    };
  },
});

// ─── mail_tag ────────────────────────────────────────────────────────────────

export const mailTagTool = defineTool({
  name: "mail_tag",
  label: "Tag Email(s)",
  description: "Add or remove tags from one or more emails. Accepts an array of email IDs.",
  parameters: Type.Object({
    ids: Type.Array(
      Type.String({
        description: "Email message ID(s) to tag.",
      }),
      { minItems: 1, maxItems: 50 },
    ),
    addTags: Type.Optional(
      Type.Array(
        Type.String({
          description: "Tag(s) to add.",
        }),
      ),
    ),
    removeTags: Type.Optional(
      Type.Array(
        Type.String({
          description: "Tag(s) to remove.",
        }),
      ),
    ),
  }),
  execute: async (_toolCallId, params) => {
    const emails = await prisma.emailMessage.findMany({
      where: { id: { in: params.ids } },
      select: { id: true, tags: true },
    });

    const updatedIds: string[] = [];
    for (const email of emails) {
      let newTags = [...email.tags];
      if (params.addTags) {
        for (const tag of params.addTags) {
          if (!newTags.includes(tag)) {
            newTags.push(tag);
          }
        }
      }
      if (params.removeTags) {
        newTags = newTags.filter((t) => !params.removeTags!.includes(t));
      }
      await prisma.emailMessage.update({
        where: { id: email.id },
        data: { tags: newTags },
      });
      updatedIds.push(email.id);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              updated: updatedIds.length,
              ids: updatedIds,
            },
            null,
            2,
          ),
        },
      ],
      details: { updated: updatedIds.length },
    };
  },
});

// ─── mail_move ───────────────────────────────────────────────────────────────

export const mailMoveTool = defineTool({
  name: "mail_move",
  label: "Move Email(s)",
  description: "Move one or more emails between folders. Accepts an array of email IDs.",
  parameters: Type.Object({
    ids: Type.Array(
      Type.String({
        description: "Email message ID(s) to move.",
      }),
      { minItems: 1, maxItems: 50 },
    ),
    folder: Type.String({
      description: 'Target folder (e.g. "INBOX", "Archive", "Trash", "Spam").',
    }),
  }),
  execute: async (_toolCallId, params) => {
    const result = await prisma.emailMessage.updateMany({
      where: { id: { in: params.ids } },
      data: { folder: params.folder },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              moved: result.count,
              folder: params.folder,
            },
            null,
            2,
          ),
        },
      ],
      details: { moved: result.count },
    };
  },
});

// ─── mail_delete ─────────────────────────────────────────────────────────────

export const mailDeleteTool = defineTool({
  name: "mail_delete",
  label: "Delete Email(s)",
  description: "Permanently delete one or more emails. Accepts an array of email IDs.",
  parameters: Type.Object({
    ids: Type.Array(
      Type.String({
        description: "Email message ID(s) to delete.",
      }),
      { minItems: 1, maxItems: 50 },
    ),
  }),
  execute: async (_toolCallId, params) => {
    const result = await prisma.emailMessage.deleteMany({
      where: { id: { in: params.ids } },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              deleted: result.count,
            },
            null,
            2,
          ),
        },
      ],
      details: { deleted: result.count },
    };
  },
});

// ─── Export all mail tools ───────────────────────────────────────────────────

export const mailTools = [
  mailListTool,
  mailReadTool,
  mailSearchTool,
  mailSendTool,
  mailTagTool,
  mailMoveTool,
  mailDeleteTool,
];
