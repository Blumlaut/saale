import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { sendEmail } from "@/lib/email/smtp";
import { syncEmailAccount } from "@/lib/email/sync";

// ─── mail_accounts ───────────────────────────────────────────────────────────

export const mailAccountsTool = defineTool({
  name: "mail_accounts",
  label: "List Email Accounts",
  description:
    "List all connected email accounts with their metadata: IDs, addresses, enabled status, last sync time, folder list, and message counts per folder.",
  parameters: Type.Object({}),
  execute: async (_toolCallId) => {
    const accounts = await prisma.emailAccount.findMany({
      select: {
        id: true,
        email: true,
        enabled: true,
        lastSyncedAt: true,
        cachedFolders: true,
      },
    });

    // Get per-folder message counts for each account
    const results = await Promise.all(
      accounts.map(async (acc) => {
        const folderCounts = await prisma.emailMessage.groupBy({
          by: ["folder"],
          where: { accountId: acc.id },
          _count: { folder: true },
        });

        const totalMessages = folderCounts.reduce((sum, f) => sum + f._count.folder, 0);
        const unreadCount = await prisma.emailMessage.count({
          where: { accountId: acc.id, isRead: false },
        });

        return {
          id: acc.id,
          email: acc.email,
          enabled: acc.enabled,
          lastSyncedAt: acc.lastSyncedAt?.toISOString() ?? null,
          folders: (acc.cachedFolders as string[] | null) ?? [],
          messageCounts: Object.fromEntries(folderCounts.map((f) => [f.folder, f._count.folder])),
          totalMessages,
          unreadCount,
        };
      }),
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ accounts: results }, null, 2),
        },
      ],
      details: { count: results.length },
    };
  },
});

// ─── mail_folders ────────────────────────────────────────────────────────────

export const mailFoldersTool = defineTool({
  name: "mail_folders",
  label: "List Folders",
  description:
    "List all folders for a specific email account with message counts (total, unread, starred) per folder.",
  parameters: Type.Object({
    accountId: Type.String({
      description: "The email account ID.",
    }),
  }),
  execute: async (_toolCallId, params) => {
    const account = await prisma.emailAccount.findUnique({
      where: { id: params.accountId },
      select: { id: true, email: true, cachedFolders: true },
    });

    if (!account) {
      throw new Error(`Email account ${params.accountId} not found`);
    }

    const folderStats = await prisma.emailMessage.groupBy({
      by: ["folder"],
      where: { accountId: account.id },
      _count: { id: true },
    });

    // Get unread and starred counts per folder
    const folderDetails = await Promise.all(
      folderStats.map(async (f) => {
        const unread = await prisma.emailMessage.count({
          where: { accountId: account.id, folder: f.folder, isRead: false },
        });
        const starred = await prisma.emailMessage.count({
          where: { accountId: account.id, folder: f.folder, isStarred: true },
        });

        return {
          name: f.folder,
          total: f._count.id,
          unread,
          starred,
        };
      }),
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              accountId: account.id,
              email: account.email,
              remoteFolders: (account.cachedFolders as string[] | null) ?? [],
              folders: folderDetails,
            },
            null,
            2,
          ),
        },
      ],
      details: { count: folderDetails.length },
    };
  },
});

// ─── mail_sync ───────────────────────────────────────────────────────────────

export const mailSyncTool = defineTool({
  name: "mail_sync",
  label: "Sync Email Account",
  description:
    "Trigger an IMAP sync for a specific email account to fetch new messages. Returns sync results.",
  parameters: Type.Object({
    accountId: Type.String({
      description: "The email account ID to sync.",
    }),
  }),
  execute: async (_toolCallId, params) => {
    const result = await syncEmailAccount(params.accountId);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              accountId: params.accountId,
              newMessages: result.newMessages,
              updatedMessages: result.updatedMessages,
              errors: result.errors.length > 0 ? result.errors : undefined,
            },
            null,
            2,
          ),
        },
      ],
      details: { newMessages: result.newMessages, updatedMessages: result.updatedMessages },
    };
  },
});

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
  mailAccountsTool,
  mailFoldersTool,
  mailSyncTool,
  mailListTool,
  mailReadTool,
  mailSearchTool,
  mailSendTool,
  mailTagTool,
  mailMoveTool,
  mailDeleteTool,
];
