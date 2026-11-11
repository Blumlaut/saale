import { E2E_EMAIL } from "./utils";
import { withDb, type Db } from "./db";

/**
 * Fixtures a spec needs on screen: a transcript long enough to page, a mailbox
 * the inbox can list without an IMAP server.
 *
 * Both are written to the database the app under test reads, scoped to the
 * shared e2e account, and removed by the spec that made them.
 */

/** The signed-in e2e account's id, or a failure that names what is missing. */
async function e2eUserId(db: Db): Promise<string> {
  const user = await db.user.findFirst({ where: { email: E2E_EMAIL }, select: { id: true } });
  if (!user) throw new Error(`e2e: no ${E2E_EMAIL} row, did global setup run?`);
  return user.id;
}

/**
 * `count` messages in a chat, one every second from 2026-01-01, alternating
 * speaker, each named after its position so a spec can read the order off the
 * screen.
 */
export async function seedTranscript(sessionId: string, count: number): Promise<void> {
  await withDb((db) =>
    db.chatMessage.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        sessionId,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `seeded message ${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      })),
    }),
  );
}

/** Remove a chat's messages, leaving the chat itself alone. */
export async function clearTranscript(sessionId: string): Promise<void> {
  await withDb((db) => db.chatMessage.deleteMany({ where: { sessionId } }));
}

/**
 * A user message carrying one file chip per name, in the order given.
 *
 * Non-image attachments make the order readable without a file on disk: a chip
 * has a width whatever the attachment points at.
 */
export async function seedAttachmentMessage(sessionId: string, names: string[]): Promise<void> {
  await withDb((db) =>
    db.chatMessage.create({
      data: {
        sessionId,
        role: "user",
        content: "seeded attachments",
        createdAt: new Date(Date.UTC(2026, 0, 2)),
        attachments: {
          create: names.map((fileName, index) => ({
            storageId: `e2e-${sessionId}-${index}`,
            fileName,
            mimeType: "text/plain",
            size: 1024,
            storagePath: `files/${fileName}`,
          })),
        },
      },
      select: { id: true },
    }),
  );
}

/**
 * A mailbox the inbox can list without an IMAP server.
 *
 * The account is never synced, so its password is a placeholder that no code
 * path under test ever decrypts.
 */
export async function seedMailbox(count: number): Promise<string> {
  return withDb(async (db) => {
    const userId = await e2eUserId(db);
    const email = "e2e-mailbox@saale.local";
    const account = await db.emailAccount.upsert({
      where: { userId_email: { userId, email } },
      create: {
        userId,
        email,
        imapHost: "imap.invalid",
        imapPort: 993,
        smtpHost: "smtp.invalid",
        smtpPort: 465,
        encryptedPassword: "e2e-not-a-real-credential",
        cachedFolders: ["INBOX", "Sent"],
      },
      update: { cachedFolders: ["INBOX", "Sent"] },
      select: { id: true },
    });

    // A run that died mid-spec leaves its rows behind, and a UID is unique per
    // folder: start from empty.
    await db.emailMessage.deleteMany({ where: { accountId: account.id } });
    await db.emailMessage.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        accountId: account.id,
        uid: String(index + 1),
        fromName: `Sender ${index + 1}`,
        fromEmail: `sender${index + 1}@example.com`,
        to: JSON.stringify([email]),
        subject: `seeded mail ${index + 1}`,
        date: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        bodyPreview: `Preview of seeded mail ${index + 1}`,
        folder: "INBOX",
        // Older rows read, so the unread count in the composer is predictable.
        isRead: index !== count - 1,
        tags: [],
      })),
    });

    return account.id;
  });
}

/** Drop the seeded mailbox and its messages. */
export async function clearMailbox(): Promise<void> {
  await withDb(async (db) => {
    const userId = await e2eUserId(db);
    await db.emailAccount.deleteMany({
      where: { userId, email: "e2e-mailbox@saale.local" },
    });
  });
}
