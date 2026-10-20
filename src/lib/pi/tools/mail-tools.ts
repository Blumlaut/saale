import path from "path";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { sendMailForAccount } from "@/lib/email/send-mail";
import { learnContactsFromSend } from "@/lib/contacts/contacts";
import { syncEmailAccount } from "@/lib/email/sync";
import { fetchMessageBody, moveMessage, deleteMessage, syncMessageFlags } from "@/lib/email/imap";
import { getUploadsDir } from "@/lib/uploads";

function getUserDir(userId: string): string {
  return path.join(getUploadsDir(), userId);
}

/** Fetch all account IDs belonging to a user. Used for user-isolated queries. */
export async function getUserAccountIds(userId: string): Promise<string[]> {
  const accounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: { id: true },
  });
  return accounts.map((a) => a.id);
}

/** Format a sender as "Name <email>" or just "email" when name is missing. */
export function formatFrom(fromName: string | null, fromEmail: string): string {
  return fromName ? `${fromName} <${fromEmail}>` : fromEmail;
}

/**
 * A mail message as the mail tools report it. mail_list, mail_read and
 * mail_search all emit this shape, but each selects a different subset of
 * fields, so a field a given tool does not fetch is simply absent.
 */
const MAIL_MESSAGE_SCHEMA = Type.Object({
  id: Type.String(),
  from: Type.String(),
  subject: Type.String(),
  date: Type.String(),
  read: Type.Boolean(),
  folder: Type.String(),
  // mail_list and mail_read
  to: Type.Optional(Type.String()),
  starred: Type.Optional(Type.Boolean()),
  tags: Type.Optional(Type.Array(Type.String())),
  // mail_list and mail_search
  preview: Type.Optional(Type.String()),
  // mail_list only
  uid: Type.Optional(Type.String()),
  // mail_read only
  bodyText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  aiSummary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  spamScore: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

/** A connected account with its folder list and per-folder message counts. */
const MAIL_ACCOUNT_SCHEMA = Type.Object({
  id: Type.String(),
  email: Type.String(),
  enabled: Type.Boolean(),
  lastSyncedAt: Type.Union([Type.String(), Type.Null()]),
  folders: Type.Array(Type.String()),
  messageCounts: Type.Record(Type.String(), Type.Integer()),
  totalMessages: Type.Integer(),
  unreadCount: Type.Integer(),
});

const MAIL_ACCOUNTS_SCHEMA = Type.Object({
  accounts: Type.Array(MAIL_ACCOUNT_SCHEMA),
});

const MAIL_FOLDERS_SCHEMA = Type.Object({
  accountId: Type.String(),
  email: Type.String(),
  remoteFolders: Type.Array(Type.String()),
  folders: Type.Array(
    Type.Object({
      name: Type.String(),
      total: Type.Integer(),
      unread: Type.Integer(),
      starred: Type.Integer(),
    }),
  ),
});

const MAIL_SYNC_SCHEMA = Type.Object({
  accountId: Type.String(),
  newMessages: Type.Integer(),
  updatedMessages: Type.Integer(),
  // Absent when the sync recorded no errors.
  errors: Type.Optional(Type.Array(Type.String())),
});

const MAIL_LIST_SCHEMA = Type.Object({
  count: Type.Integer(),
  total: Type.Integer(),
  hasMore: Type.Boolean(),
  emails: Type.Array(MAIL_MESSAGE_SCHEMA),
});

const MAIL_READ_SCHEMA = Type.Object({
  count: Type.Integer(),
  emails: Type.Array(MAIL_MESSAGE_SCHEMA),
});

const MAIL_SEARCH_SCHEMA = Type.Object({
  query: Type.String(),
  count: Type.Integer(),
  emails: Type.Array(MAIL_MESSAGE_SCHEMA),
});

const MAIL_SEND_SCHEMA = Type.Object({
  sent: Type.Boolean(),
  messageId: Type.String(),
  to: Type.Array(Type.String()),
  subject: Type.String(),
  /** Folder the sent copy was filed in; null when filing it failed. */
  sentFolder: Type.Union([Type.String(), Type.Null()]),
  // Absent when the send had no attachments.
  attachments: Type.Optional(Type.Array(Type.String())),
});

const MAIL_TAG_SCHEMA = Type.Object({
  updated: Type.Integer(),
  ids: Type.Array(Type.String()),
});

const MAIL_MOVE_SCHEMA = Type.Object({
  moved: Type.Integer(),
  folder: Type.String(),
});

const MAIL_DELETE_SCHEMA = Type.Object({
  deleted: Type.Integer(),
});

/**
 * Create mail tools with userId injection for user isolation.
 * All queries are scoped to the authenticated user's email accounts.
 * Returns an array of tool definitions for direct spread into the agent session.
 */
export function createMailTools(userId: string): ToolDefinition[] {
  return [
    // ─── mail_accounts ──────────────────────────────────────────────────────

    defineStructuredTool({
      name: "mail_accounts",
      label: "List Email Accounts",
      description:
        "List all connected email accounts with their metadata: IDs, addresses, enabled status, last sync time, folder list, and message counts per folder.",
      parameters: Type.Object({}),
      outputSchema: MAIL_ACCOUNTS_SCHEMA,
      execute: async (_toolCallId) => {
        const accounts = await prisma.emailAccount.findMany({
          where: { userId },
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
              messageCounts: Object.fromEntries(
                folderCounts.map((f) => [f.folder, f._count.folder]),
              ),
              totalMessages,
              unreadCount,
            };
          }),
        );

        return {
          value: { accounts: results },
          details: { count: results.length },
        };
      },
    }),

    // ─── mail_folders ───────────────────────────────────────────────────────

    defineStructuredTool({
      name: "mail_folders",
      label: "List Folders",
      description:
        "List all folders for a specific email account with message counts (total, unread, starred) per folder.",
      parameters: Type.Object({
        accountId: Type.String({
          description: "The email account ID.",
        }),
      }),
      outputSchema: MAIL_FOLDERS_SCHEMA,
      execute: async (_toolCallId, params) => {
        const account = await prisma.emailAccount.findFirst({
          where: { id: params.accountId, userId },
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
          value: {
            accountId: account.id,
            email: account.email,
            remoteFolders: (account.cachedFolders as string[] | null) ?? [],
            folders: folderDetails,
          },
          details: { count: folderDetails.length },
        };
      },
    }),

    // ─── mail_sync ──────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "mail_sync",
      label: "Sync Email Account",
      description:
        "Trigger an IMAP sync for a specific email account to fetch new messages. Returns sync results.",
      parameters: Type.Object({
        accountId: Type.String({
          description: "The email account ID to sync.",
        }),
      }),
      outputSchema: MAIL_SYNC_SCHEMA,
      execute: async (_toolCallId, params) => {
        const account = await prisma.emailAccount.findFirst({
          where: { id: params.accountId, userId },
          select: { id: true },
        });

        if (!account) {
          throw new Error(`Email account ${params.accountId} not found`);
        }

        const result = await syncEmailAccount(params.accountId);

        return {
          value: {
            accountId: params.accountId,
            newMessages: result.newMessages,
            updatedMessages: result.updatedMessages,
            ...(result.errors.length > 0 ? { errors: result.errors } : {}),
          },
          details: { newMessages: result.newMessages, updatedMessages: result.updatedMessages },
        };
      },
    }),

    // ─── mail_list ──────────────────────────────────────────────────────────

    defineStructuredTool({
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
      outputSchema: MAIL_LIST_SCHEMA,
      execute: async (_toolCallId, params) => {
        const accountIds = await getUserAccountIds(userId);

        const where: Record<string, unknown> = {
          accountId: { in: accountIds },
        };

        if (params.accountId) {
          // Verify the requested account belongs to this user
          if (!accountIds.includes(params.accountId)) {
            throw new Error(`Email account ${params.accountId} not found`);
          }
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

        const emailData = emails.map(
          (e: {
            id: string;
            uid: string;
            fromName: string | null;
            fromEmail: string;
            to: string;
            subject: string;
            date: Date;
            bodyPreview: string | null;
            isRead: boolean;
            isStarred: boolean;
            folder: string;
            tags: string[];
          }) => ({
            id: e.id,
            uid: e.uid,
            from: formatFrom(e.fromName, e.fromEmail),
            to: e.to,
            subject: e.subject,
            date: e.date.toISOString(),
            preview: (e.bodyPreview ?? "").slice(0, 200),
            read: e.isRead,
            starred: e.isStarred,
            folder: e.folder,
            tags: e.tags,
          }),
        );

        // Structured metadata for UI rendering (email cards)
        const mailMeta = {
          _saaleMailMeta: {
            type: "mail_list" as const,
            count: emails.length,
            total,
            emails: emailData,
          },
        };

        return {
          value: {
            count: emails.length,
            total,
            hasMore: emails.length < total - (params.offset ?? 0),
            emails: emailData,
          },
          meta: mailMeta,
          details: { count: emails.length, total },
        };
      },
    }),

    // ─── mail_read ──────────────────────────────────────────────────────────

    defineStructuredTool({
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
      outputSchema: MAIL_READ_SCHEMA,
      execute: async (_toolCallId, params) => {
        const accountIds = await getUserAccountIds(userId);

        const emails = await prisma.emailMessage.findMany({
          where: {
            id: { in: params.ids },
            accountId: { in: accountIds },
          },
          select: {
            id: true,
            uid: true,
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
            spamScore: true,
            accountId: true,
          },
        });

        // Mark as read in DB
        const unreadEmails = emails.filter((e) => !e.isRead);
        if (unreadEmails.length > 0) {
          await prisma.emailMessage.updateMany({
            where: { id: { in: params.ids }, accountId: { in: accountIds } },
            data: { isRead: true },
          });

          // Push \Seen flag to IMAP server (best-effort, fire-and-forget)
          for (const msg of unreadEmails) {
            syncMessageFlags(msg.accountId, msg.folder, msg.uid, {
              isRead: true,
            }).catch(() => {
              // Already logged inside syncMessageFlags
            });
          }
        }

        // Fetch bodies on-demand for messages that don't have them yet
        const emailsWithoutBody = emails.filter((e) => !e.bodyHtml && !e.bodyText);
        if (emailsWithoutBody.length > 0) {
          const bodyResults = await Promise.all(
            emailsWithoutBody.map(async (e) => ({ id: e.id, body: await fetchMessageBody(e.id) })),
          );
          const bodyMap = new Map(bodyResults.map((r) => [r.id, r.body]));
          // Merge fetched bodies into the emails array
          for (const email of emails) {
            const body = bodyMap.get(email.id);
            if (body) {
              email.bodyHtml = body.bodyHtml;
              email.bodyText = body.bodyText;
              email.bodyPreview = body.bodyPreview;
            }
          }
        }

        const emailData = emails.map(
          (e: {
            id: string;
            fromName: string | null;
            fromEmail: string;
            to: string;
            subject: string;
            date: Date;
            bodyText: string | null;
            bodyHtml: string | null;
            bodyPreview: string | null;
            isRead: boolean;
            isStarred: boolean;
            folder: string;
            tags: string[];
            aiSummary: string | null;
            spamScore: number | null;
          }) => ({
            id: e.id,
            from: formatFrom(e.fromName, e.fromEmail),
            to: e.to,
            subject: e.subject,
            date: e.date.toISOString(),
            bodyText: e.bodyText ?? e.bodyPreview,
            read: e.isRead,
            starred: e.isStarred,
            folder: e.folder,
            tags: e.tags,
            aiSummary: e.aiSummary,
            spamScore: e.spamScore,
          }),
        );

        // Structured metadata for UI rendering (email read card)
        const mailMeta = {
          _saaleMailMeta: {
            type: "mail_read" as const,
            count: emails.length,
            emails: emailData,
          },
        };

        return {
          value: { count: emails.length, emails: emailData },
          // The text has always been the message array itself; the value a
          // script reads is the same array under a count.
          text: JSON.stringify(emailData, null, 2),
          meta: mailMeta,
          details: { count: emails.length },
        };
      },
    }),

    // ─── mail_search ────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "mail_search",
      label: "Search Emails",
      description:
        "Search emails across all connected accounts. Searches subject, body, and sender. " +
        'Each word in the query is matched independently (OR logic), so "invoice march" finds emails containing either word.',
      parameters: Type.Object({
        query: Type.String({
          description:
            'Search keyword(s). Use 1-2 words. each word is matched independently (OR logic). e.g. "invoice march" finds emails with either word.',
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
      outputSchema: MAIL_SEARCH_SCHEMA,
      execute: async (_toolCallId, params) => {
        const accountIds = await getUserAccountIds(userId);

        // Split multi-word queries into individual terms so "hello world" matches emails
        // containing either "hello" OR "world" (not just the exact phrase "hello world")
        const terms = params.query.split(/\s+/).filter(Boolean);
        const searchTerms = terms.length > 0 ? terms : [params.query];

        const where: Record<string, unknown> = {
          accountId: { in: accountIds },
          OR: searchTerms.flatMap((term: string) => [
            { subject: { contains: term, mode: "insensitive" } },
            { bodyText: { contains: term, mode: "insensitive" } },
            { bodyPreview: { contains: term, mode: "insensitive" } },
            { fromEmail: { contains: term, mode: "insensitive" } },
            { fromName: { contains: term, mode: "insensitive" } },
          ]),
        };

        if (params.accountId) {
          if (!accountIds.includes(params.accountId)) {
            throw new Error(`Email account ${params.accountId} not found`);
          }
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

        const emailData = emails.map(
          (e: {
            id: string;
            fromName: string | null;
            fromEmail: string;
            subject: string;
            date: Date;
            bodyPreview: string | null;
            isRead: boolean;
            folder: string;
          }) => ({
            id: e.id,
            from: formatFrom(e.fromName, e.fromEmail),
            subject: e.subject,
            date: e.date.toISOString(),
            preview: (e.bodyPreview ?? "").slice(0, 200),
            read: e.isRead,
            folder: e.folder,
          }),
        );

        // Structured metadata for UI rendering (email cards)
        const mailMeta = {
          _saaleMailMeta: {
            type: "mail_search" as const,
            query: params.query,
            count: emails.length,
            emails: emailData,
          },
        };

        return {
          value: {
            query: params.query,
            count: emails.length,
            emails: emailData,
          },
          meta: mailMeta,
          details: { count: emails.length },
        };
      },
    }),

    // ─── mail_send ──────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "mail_send",
      label: "Send Email",
      description:
        "Send an email via SMTP using the user's configured email account. " +
        "The sent message is filed in the account's Sent folder. " +
        "Supports file attachments from the workspace using relative file paths. " +
        "If the user refers to a recipient by name, resolve the address with " +
        "contacts_search before sending.",
      parameters: Type.Object({
        accountId: Type.String({
          description: "The email account ID to send from.",
        }),
        to: Type.Array(
          Type.String({
            description: "Recipient email address(es), optionally `Name <email>`.",
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
        attachments: Type.Optional(
          Type.Array(
            Type.String({
              description:
                "File path(s) relative to the workspace root. Files are read from the user's isolated workspace directory.",
            }),
            {
              description: "Optional list of file paths to attach.",
              minItems: 1,
              maxItems: 10,
            },
          ),
        ),
      }),
      outputSchema: MAIL_SEND_SCHEMA,
      execute: async (_toolCallId, params) => {
        const account = await prisma.emailAccount.findFirst({
          where: { id: params.accountId, userId },
        });

        if (!account) {
          throw new Error(`Email account ${params.accountId} not found`);
        }

        const password = decrypt(account.encryptedPassword);

        const result = await sendMailForAccount({
          account,
          password,
          to: params.to,
          subject: params.subject,
          body: params.body,
          ...(params.bodyHtml ? { bodyHtml: params.bodyHtml } : {}),
          ...(params.replyTo ? { replyTo: params.replyTo } : {}),
          ...(params.attachments
            ? { attachmentPaths: params.attachments, attachmentBaseDir: getUserDir(userId) }
            : {}),
        });

        // The learner never throws. the book must not fail the send.
        await learnContactsFromSend(userId, params.to);

        return {
          value: {
            sent: true,
            messageId: result.messageId,
            to: params.to,
            subject: params.subject,
            sentFolder: result.sentFolder,
            ...(params.attachments
              ? { attachments: params.attachments.map((p: string) => path.basename(p)) }
              : {}),
          },
          details: { messageId: result.messageId, sentFolder: result.sentFolder },
        };
      },
    }),

    // ─── mail_tag ───────────────────────────────────────────────────────────

    defineStructuredTool({
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
      outputSchema: MAIL_TAG_SCHEMA,
      execute: async (_toolCallId, params) => {
        const accountIds = await getUserAccountIds(userId);

        const emails = await prisma.emailMessage.findMany({
          where: { id: { in: params.ids }, accountId: { in: accountIds } },
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
          value: {
            updated: updatedIds.length,
            ids: updatedIds,
          },
          details: { updated: updatedIds.length },
        };
      },
    }),

    // ─── mail_move ──────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "mail_move",
      label: "Move Email(s)",
      description:
        "Move one or more emails between folders. Syncs to the IMAP server. Accepts an array of email IDs.",
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
      outputSchema: MAIL_MOVE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const accountIds = await getUserAccountIds(userId);

        // Fetch messages before updating so we have uid + folder for IMAP sync
        const messages = await prisma.emailMessage.findMany({
          where: { id: { in: params.ids }, accountId: { in: accountIds } },
          select: { id: true, uid: true, folder: true, accountId: true },
        });

        const result = await prisma.emailMessage.updateMany({
          where: { id: { in: params.ids }, accountId: { in: accountIds } },
          data: { folder: params.folder },
        });

        // Push moves to IMAP server (best-effort, fire-and-forget)
        for (const msg of messages) {
          moveMessage(msg.accountId, msg.folder, msg.uid, params.folder).catch(() => {
            // Already logged inside moveMessage
          });
        }

        return {
          value: {
            moved: result.count,
            folder: params.folder,
          },
          details: { moved: result.count },
        };
      },
    }),

    // ─── mail_delete ────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "mail_delete",
      label: "Delete Email(s)",
      description:
        "Delete one or more emails. Syncs to the IMAP server (sets \Deleted flag). Accepts an array of email IDs.",
      parameters: Type.Object({
        ids: Type.Array(
          Type.String({
            description: "Email message ID(s) to delete.",
          }),
          { minItems: 1, maxItems: 50 },
        ),
      }),
      outputSchema: MAIL_DELETE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const accountIds = await getUserAccountIds(userId);

        // Fetch messages before deleting so we have uid + folder for IMAP sync
        const messages = await prisma.emailMessage.findMany({
          where: { id: { in: params.ids }, accountId: { in: accountIds } },
          select: { id: true, uid: true, folder: true, accountId: true },
        });

        // Push deletes to IMAP server first (best-effort)
        for (const msg of messages) {
          deleteMessage(msg.accountId, msg.folder, msg.uid).catch(() => {
            // Already logged inside deleteMessage
          });
        }

        const result = await prisma.emailMessage.deleteMany({
          where: { id: { in: params.ids }, accountId: { in: accountIds } },
        });

        return {
          value: {
            deleted: result.count,
          },
          details: { deleted: result.count },
        };
      },
    }),
  ];
}
