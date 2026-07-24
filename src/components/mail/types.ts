import type { EmailAccount } from "@/types/shared";

export interface EmailMessage {
  id: string;
  uid: string;
  fromName: string | null;
  fromEmail: string;
  to: unknown;
  subject: string;
  date: string;
  bodyPreview: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  isRead: boolean;
  isStarred: boolean;
  folder: string;
  tags: string[];
  accountId: string;
}

export interface EmailMessageDetail extends EmailMessage {
  bodyHtml: string | null;
  bodyText: string | null;
}

export interface InboxEmailAccount extends EmailAccount {
  remoteFolders: string[];
}
