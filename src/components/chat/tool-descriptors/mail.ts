import { Mail, MailOpen } from "lucide-react";
import { formatRelativeDate, plural, truncate } from "@/lib/format";
import { extractToolMeta } from "@/lib/chat/tool-meta";
import { toolStatus } from "../tool-status";
import type { ToolCardModel, ToolDescriptor, ToolRowMark, ToolRowModel } from "../tool-card-model";

/** Max characters before truncation. */
const MAX_SUBJECT = 80;
const MAX_PREVIEW = 120;
const MAX_FROM = 30;
const MAX_QUERY = 50;
const MAX_FOLDER = 16;

/**
 * Structured metadata embedded in mail tool results.
 * Extracted from the `_saaleMailMeta` block appended by the tools.
 */
interface MailEntry {
  id: string;
  from: string;
  subject: string;
  date: string;
  preview: string;
  read: boolean;
  starred?: boolean;
  folder: string;
  tags?: string[];
}

interface MailListMeta {
  type: "mail_list";
  count: number;
  total: number;
  emails: MailEntry[];
}

interface MailSearchMeta {
  type: "mail_search";
  query: string;
  count: number;
  emails: MailEntry[];
}

interface MailReadMeta {
  type: "mail_read";
  count: number;
  emails: MailEntry[];
}

type MailMeta = MailListMeta | MailSearchMeta | MailReadMeta;

/** Cards for the mail tools. all three are a list of emails with a heading. */
export const mailToolDescriptor: ToolDescriptor = {
  names: ["mail_list", "mail_search", "mail_read"],
  describe(toolCall): ToolCardModel | null {
    const meta = extractToolMeta<MailMeta>(toolCall.result);
    if (!meta) return null;

    if (meta.type === "mail_read") {
      const first = meta.emails[0];
      if (!first) return null;
      return {
        icon: MailOpen,
        title: "Read mail",
        detail: truncate(first.subject || "(no subject)", MAX_SUBJECT),
        status: toolStatus(toolCall, plural(meta.count, "email", "emails")),
        defaultOpen: true,
        blocks: [{ kind: "rows", items: meta.emails.map(mailRow) }],
      };
    }

    const isSearch = meta.type === "mail_search";
    const query = isSearch ? truncate(meta.query, MAX_QUERY) : "";

    return {
      icon: isSearch ? MailOpen : Mail,
      title: isSearch ? "Searched mail" : "Listed mail",
      ...(query ? { detail: `“${query}”` } : {}),
      status: toolStatus(toolCall, plural(meta.count, "email", "emails")),
      defaultOpen: true,
      blocks: [
        {
          kind: "rows",
          items: meta.emails.map(mailRow),
          empty: isSearch ? "No matching emails" : "No emails found",
        },
      ],
    };
  },
};

function mailRow(email: MailEntry): ToolRowModel {
  const marks: ToolRowMark[] = [];
  if (!email.read) marks.push("dot");
  if (email.starred) marks.push("star");

  return {
    leading: { kind: "avatar", label: initials(email.from), color: avatarColor(email.from) },
    title: truncate(email.from, MAX_FROM),
    lines: [
      { text: truncate(email.subject || "(no subject)", MAX_SUBJECT) },
      ...(email.preview
        ? [{ text: truncate(email.preview, MAX_PREVIEW), muted: true, clamp: true }]
        : []),
    ],
    marks,
    meta: [
      { kind: "text", text: formatRelativeDate(email.date) },
      { kind: "badge", text: truncate(email.folder, MAX_FOLDER) },
    ],
  };
}

/** "Alice Smith <a@b.com>" → "AS"; a bare address falls back to its local part. */
function initials(from: string): string {
  const name = from.match(/^(.+?)</)?.[1]?.trim();
  if (name) {
    return name
      .split(" ")
      .map((word) => word[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }
  const email = address(from);
  return (email.split("@")[0] ?? email).slice(0, 2).toUpperCase();
}

/** A stable hue per sender domain, so the same sender keeps its avatar colour. */
function avatarColor(from: string): string {
  const host = address(from).split("@")[1] ?? from;
  let hash = 0;
  for (let i = 0; i < host.length; i++) {
    hash = host.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 40%, 55%)`;
}

/** The address part of "Name <address>". */
function address(from: string): string {
  return from.match(/<([^>]+)>/)?.[1] ?? from;
}
