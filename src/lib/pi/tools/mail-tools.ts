import path from "path";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { sendMailForAccount } from "@/lib/email/send-mail";
import { learnContactsFromSend } from "@/lib/contacts/contacts";
import { searchMail } from "@/lib/search/sources";
import { snippetAround } from "@/lib/search/snippet";
import { syncEmailAccount } from "@/lib/email/sync";
import { fetchMessageBody, deleteMessage, syncMessageFlags } from "@/lib/email/imap";
import { emailBodyText } from "@/lib/email/body-text";
import { folderTargetFrom, resolveFolderRef, specialFolder } from "@/lib/email/folders";
import { fileMessage } from "@/lib/email/file-message";
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
  uid: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  starred: Type.Optional(Type.Boolean()),
  tags: Type.Optional(Type.Array(Type.String())),
  // mail_list and mail_search
  preview: Type.Optional(Type.String()),
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
  /** Folder a sent copy is appended to on the server; null when none was resolved yet. */
  sentFolder: Type.Union([Type.String(), Type.Null()]),
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
      description: "List all connected email accounts with their addresses and enabled status.",
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
          select: { id: true, email: true, cachedFolders: true, specialFolders: true },
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
            sentFolder: specialFolder(folderTargetFrom(account), "\\Sent"),
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
        const folderRef = params.folder;
        if (folderRef) {
          // Each server names its folders its own way, so the reference is
          // resolved per account rather than matched literally.
          const accounts = await prisma.emailAccount.findMany({
            where: { id: { in: params.accountId ? [params.accountId] : accountIds } },
            select: { id: true, specialFolders: true, cachedFolders: true },
          });
          const folders = accounts.flatMap((account) => {
            const resolved = resolveFolderRef(folderTargetFrom(account), folderRef);
            return resolved ? [{ accountId: account.id, folder: resolved }] : [];
          });

          if (folders.length === 0) {
            const known = [...new Set(accounts.flatMap((a) => folderTargetFrom(a).folders))];
            throw new Error(
              `No folder "${folderRef}" on this account. Folders: INBOX${known.length > 0 ? `, ${known.join(", ")}` : " (none synced yet)"}`,
            );
          }
          where.OR = folders;
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

        // Fetch bodies on-demand for messages that don't have them yet, and for the
        // html-only mail whose text part came back empty.
        const emailsWithoutBody = emails.filter(
          (e) => !emailBodyText({ text: e.bodyText, html: e.bodyHtml }),
        );
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
            uid: string;
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
            uid: e.uid,
            from: formatFrom(e.fromName, e.fromEmail),
            to: e.to,
            subject: e.subject,
            date: e.date.toISOString(),
            bodyText: emailBodyText({ text: e.bodyText, html: e.bodyHtml }) ?? e.bodyPreview,
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
          text: JSON.stringify(emailData),
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
        "Search emails across all connected accounts by subject, body, and sender. " +
        "Every word must appear somewhere in the email, so add words to narrow the result. " +
        'Spelling and word forms are forgiven: "invoce march" still finds "invoice for March".',
      parameters: Type.Object({
        query: Type.String({
          description:
            'Search words. Two or three specific words beat one common one. Every word has to match, e.g. "invoice march" finds only emails with both.',
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

        if (params.accountId && !accountIds.includes(params.accountId)) {
          throw new Error(`Email account ${params.accountId} not found`);
        }

        if (!params.query.trim()) {
          return { value: { query: params.query, count: 0, emails: [] }, details: { count: 0 } };
        }

        const emails = await searchMail(params.query, {
          accountIds,
          filters: { accountId: params.accountId },
          limit: params.limit ?? 20,
        });

        const emailData = emails.map((e) => ({
          id: e.id,
          from: formatFrom(e.fromName, e.fromEmail),
          subject: e.subject,
          date: e.date.toISOString(),
          preview: snippetAround(e.bodyPreview ?? "", params.query, 200),
          read: e.isRead,
          folder: e.folder,
        }));

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
          description:
            'Target folder. Accepts the special-use name ("Sent", "Trash", "Archive", "Drafts") or a folder path from mail_folders.',
        }),
      }),
      outputSchema: MAIL_MOVE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const accountIds = await getUserAccountIds(userId);

        // Fetch messages before moving so we have uid + folder for IMAP sync
        const messages = await prisma.emailMessage.findMany({
          where: { id: { in: params.ids }, accountId: { in: accountIds } },
          select: { id: true, uid: true, folder: true, accountId: true },
        });
        if (messages.length === 0) {
          return { value: { moved: 0, folder: params.folder }, details: { moved: 0 } };
        }

        const accounts = await prisma.emailAccount.findMany({
          where: { id: { in: [...new Set(messages.map((m) => m.accountId))] }, userId },
          select: { id: true, email: true, specialFolders: true, cachedFolders: true },
        });

        // One resolution per account: the same name can be a different path.
        const destinations = new Map<string, string>();
        for (const account of accounts) {
          const destination = resolveFolderRef(folderTargetFrom(account), params.folder);
          if (!destination) {
            const known = folderTargetFrom(account).folders;
            throw new Error(
              `Account ${account.email} has no folder "${params.folder}". Its folders: ${known.length > 0 ? known.join(", ") : "none synced yet"}`,
            );
          }
          destinations.set(account.id, destination);
        }

        let moved = 0;
        for (const message of messages) {
          const destination = destinations.get(message.accountId);
          if (!destination) continue;
          const outcome = await fileMessage({ message, destination });
          if (outcome.moved) moved++;
        }

        const [onlyDestination] = [...new Set(destinations.values())];
        return {
          value: {
            moved,
            folder: destinations.size === 1 && onlyDestination ? onlyDestination : params.folder,
          },
          details: { moved },
        };
      },
    }),

    // ─── mail_delete ────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "mail_delete",
      label: "Delete Email(s)",
      description:
        "Move one or more emails to the account's trash folder. A server without one deletes them outright. Accepts an array of email IDs.",
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

        const accounts = await prisma.emailAccount.findMany({
          where: { id: { in: [...new Set(messages.map((m) => m.accountId))] }, userId },
          select: { id: true, specialFolders: true, cachedFolders: true },
        });
        const trashFolders = new Map(
          accounts.map((account) => [
            account.id,
            specialFolder(folderTargetFrom(account), "\\Trash"),
          ]),
        );

        let deleted = 0;
        for (const message of messages) {
          const trashFolder = trashFolders.get(message.accountId);
          if (trashFolder && trashFolder !== message.folder) {
            const outcome = await fileMessage({ message, destination: trashFolder });
            if (outcome.moved) deleted++;
            continue;
          }

          deleteMessage(message.accountId, message.folder, message.uid).catch(() => {
            // Already logged inside deleteMessage
          });
          await prisma.emailMessage.delete({ where: { id: message.id } });
          deleted++;
        }

        return {
          value: {
            deleted,
          },
          details: { deleted },
        };
      },
    }),
  ];
}
