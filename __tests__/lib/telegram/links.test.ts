import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * These tests run against a small fake of the two tables the link flow owns,
 * so the transaction semantics that make a code single-use are actually
 * exercised rather than asserted through mock call shapes.
 */

interface FakeCode {
  id: string;
  codeHash: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

interface FakeLink {
  id: string;
  botId: string;
  userId: string;
  telegramUserId: bigint;
  telegramChatId: bigint;
  displayName: string | null;
  sessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const { fake } = vi.hoisted(() => {
  const codes = new Map<string, FakeCode>();
  const links: FakeLink[] = [];
  let codeSeq = 0;
  let linkSeq = 0;

  /**
   * The real Prisma not-found error, so the production `instanceof` check in
   * `consumeLinkCode` sees what it would see in production. Imported lazily
   * because this factory runs before the module graph is loaded.
   */
  const notFound = async () => {
    const { Prisma } = await import("@prisma/client");
    return new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "test",
    });
  };

  const telegramLinkCode = {
    async create({ data }: { data: Omit<FakeCode, "id" | "createdAt"> }) {
      const row: FakeCode = { id: `code-${++codeSeq}`, createdAt: new Date(), ...data };
      codes.set(row.codeHash, row);
      return row;
    },
    async delete({ where }: { where: { codeHash: string } }) {
      const row = codes.get(where.codeHash);
      if (!row) throw await notFound();
      codes.delete(where.codeHash);
      return row;
    },
    async deleteMany({ where }: { where: { userId: string } }) {
      let count = 0;
      for (const [hash, row] of codes) {
        if (row.userId === where.userId) {
          codes.delete(hash);
          count++;
        }
      }
      return { count };
    },
  };

  const telegramLink = {
    async findUnique({
      where,
    }: {
      where: { userId?: string; telegramUserId?: bigint };
    }): Promise<FakeLink | null> {
      if (where.userId !== undefined) {
        return links.find((l) => l.userId === where.userId) ?? null;
      }
      if (where.telegramUserId !== undefined) {
        return links.find((l) => l.telegramUserId === where.telegramUserId) ?? null;
      }
      return null;
    },
    async create({ data }: { data: Omit<FakeLink, "id" | "createdAt" | "updatedAt"> }) {
      const row: FakeLink = {
        id: `link-${++linkSeq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      links.push(row);
      return row;
    },
    async deleteMany({ where }: { where: { userId: string } }) {
      let count = 0;
      for (let i = links.length - 1; i >= 0; i--) {
        if (links[i]!.userId === where.userId) {
          links.splice(i, 1);
          count++;
        }
      }
      return { count };
    },
    async updateMany({
      where,
      data,
    }: {
      where: { telegramUserId: bigint };
      data: { displayName: string | null };
    }) {
      let count = 0;
      for (const link of links) {
        if (link.telegramUserId === where.telegramUserId) {
          Object.assign(link, data);
          count++;
        }
      }
      return { count };
    },
    async update({ where, data }: { where: { userId: string }; data: { sessionId: string } }) {
      const link = links.find((l) => l.userId === where.userId);
      if (!link) throw await notFound();
      Object.assign(link, data);
      return link;
    },
  };

  const snapshot = () => ({
    codes: new Map(codes),
    links: links.map((l) => ({ ...l })),
  });

  const restore = (snap: ReturnType<typeof snapshot>) => {
    codes.clear();
    for (const [k, v] of snap.codes) codes.set(k, v);
    links.splice(0, links.length, ...snap.links);
  };

  const prisma = {
    telegramLink,
    telegramLinkCode,
    // The interactive form rolls back on throw, like a real transaction; the
    // array form simply awaits each statement.
    $transaction: async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
      const snap = snapshot();
      try {
        return await (arg as (tx: unknown) => Promise<unknown>)({ telegramLink, telegramLinkCode });
      } catch (err) {
        restore(snap);
        throw err;
      }
    },
  };

  return { fake: { prisma, codes, links } };
});

vi.mock("@/lib/db", () => ({ prisma: fake.prisma }));

import {
  LINK_CODE_PATTERN,
  LINK_CODE_TTL_MS,
  consumeLinkCode,
  getLinkByTelegramUserId,
  getLinkByUserId,
  hashLinkCode,
  issueLinkCode,
  linkTelegramFromOidc,
  unlinkUser,
  updateLinkDisplayName,
} from "@/lib/telegram/links";

const userId = "user-1";
const otherUserId = "user-2";
const telegramUserId = BigInt("9007199254740993"); // beyond Number.MAX_SAFE_INTEGER
const telegramChatId = telegramUserId;

describe("Telegram link codes", () => {
  beforeEach(() => {
    fake.codes.clear();
    fake.links.length = 0;
  });

  it("stores only a hash of the code it hands out", async () => {
    const { code, expiresAt } = await issueLinkCode(userId);

    expect(code).toMatch(LINK_CODE_PATTERN);
    expect(fake.codes.has(code)).toBe(false);
    expect(fake.codes.has(hashLinkCode(code))).toBe(true);
    expect(fake.codes.get(hashLinkCode(code))!.userId).toBe(userId);
    // Long enough to swap apps, short enough that a leak goes stale.
    const ttl = expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(LINK_CODE_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(LINK_CODE_TTL_MS);
  });

  it("issues codes with enough entropy to be unguessable", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add((await issueLinkCode(userId)).code);
    expect(codes.size).toBe(50);
  });

  it("leaves a user with a single live code", async () => {
    const first = await issueLinkCode(userId);
    const second = await issueLinkCode(userId);

    expect(fake.codes.size).toBe(1);
    expect(fake.codes.has(hashLinkCode(second.code))).toBe(true);
    expect(
      await consumeLinkCode({
        code: first.code,
        telegramUserId,
        telegramChatId,
        displayName: null,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });
});

describe("Telegram links from a Telegram login", () => {
  beforeEach(() => {
    fake.codes.clear();
    fake.links.length = 0;
  });

  it("binds the identity the login proved, addressed by its own id", async () => {
    const result = await linkTelegramFromOidc({
      userId,
      telegramUserId,
      displayName: "Ada",
    });

    expect(result.ok).toBe(true);
    // A login carries no message to read a chat id from; a private chat with a
    // user is addressed by that user's id.
    expect(fake.links).toHaveLength(1);
    expect(fake.links[0]).toMatchObject({
      botId: "global",
      userId,
      telegramUserId,
      telegramChatId: telegramUserId,
      displayName: "Ada",
    });
    expect(await getLinkByTelegramUserId(telegramUserId)).not.toBeNull();
  });

  it("signing in again leaves one link, refreshed in place", async () => {
    await linkTelegramFromOidc({ userId, telegramUserId, displayName: "Ada" });
    await linkTelegramFromOidc({ userId, telegramUserId, displayName: "Ada Lovelace" });

    expect(fake.links).toHaveLength(1);
    expect(fake.links[0]!.displayName).toBe("Ada Lovelace");
  });

  it("moves the user's own link to the account they signed in with", async () => {
    await linkTelegramFromOidc({ userId, telegramUserId, displayName: "Ada" });

    const other = BigInt("555000111");
    await linkTelegramFromOidc({ userId, telegramUserId: other, displayName: "Ada alt" });

    expect(fake.links).toHaveLength(1);
    expect(fake.links[0]!.telegramUserId).toBe(other);
    expect(fake.links[0]!.telegramChatId).toBe(other);
  });

  it("refuses a Telegram account that is already linked to someone else", async () => {
    await linkTelegramFromOidc({ userId: otherUserId, telegramUserId, displayName: "Owner" });

    const result = await linkTelegramFromOidc({
      userId,
      telegramUserId,
      displayName: "Impostor",
    });

    expect(result).toEqual({ ok: false, reason: "already_linked" });
    expect(fake.links).toHaveLength(1);
    expect(await getLinkByUserId(otherUserId)).not.toBeNull();
    expect(await getLinkByUserId(userId)).toBeNull();
  });

  it("keeps an id beyond the safe integer range intact", async () => {
    await linkTelegramFromOidc({ userId, telegramUserId, displayName: null });

    const stored = await getLinkByUserId(userId);
    expect(stored!.telegramUserId.toString()).toBe("9007199254740993");
  });
});

describe("consumeLinkCode", () => {
  beforeEach(() => {
    fake.codes.clear();
    fake.links.length = 0;
  });

  it("links the Saale user the code was issued to", async () => {
    const { code } = await issueLinkCode(userId);

    const result = await consumeLinkCode({
      code,
      telegramUserId,
      telegramChatId,
      displayName: "Jane Doe",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.link.userId).toBe(userId);
    expect(result.link.telegramUserId).toBe(telegramUserId);
    expect(result.link.telegramChatId).toBe(telegramChatId);
    expect(fake.links).toHaveLength(1);
  });

  it("is single-use  the same code cannot link twice", async () => {
    const { code } = await issueLinkCode(userId);

    const first = await consumeLinkCode({
      code,
      telegramUserId,
      telegramChatId,
      displayName: null,
    });
    const second = await consumeLinkCode({
      code,
      telegramUserId: BigInt(5),
      telegramChatId: BigInt(5),
      displayName: null,
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "expired" });
    expect(fake.links).toHaveLength(1);
  });

  it("rejects an unknown code", async () => {
    const result = await consumeLinkCode({
      code: "A".repeat(32),
      telegramUserId,
      telegramChatId,
      displayName: null,
    });

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an expired code and keeps it out of the way", async () => {
    const { code } = await issueLinkCode(userId);
    fake.codes.get(hashLinkCode(code))!.expiresAt = new Date(Date.now() - 1_000);

    const result = await consumeLinkCode({
      code,
      telegramUserId,
      telegramChatId,
      displayName: null,
    });

    expect(result).toEqual({ ok: false, reason: "expired" });
    expect(fake.links).toHaveLength(0);
  });

  it("refuses a Telegram account already linked to someone else, without burning the code", async () => {
    await consumeLinkCode({
      code: (await issueLinkCode(otherUserId)).code,
      telegramUserId,
      telegramChatId,
      displayName: "Jane",
    });

    // user-1 gets a code, but the sender's Telegram account belongs to user-2.
    // A forwarded code must not be a takeover.
    const { code } = await issueLinkCode(userId);
    const result = await consumeLinkCode({
      code,
      telegramUserId,
      telegramChatId,
      displayName: null,
    });

    expect(result).toEqual({ ok: false, reason: "already_linked" });
    expect(await getLinkByUserId(userId)).toBeNull();
    // The code survives the rollback, so the user it was issued to can retry.
    expect(fake.codes.has(hashLinkCode(code))).toBe(true);
  });

  it("replaces the user's own previous link when they link another account", async () => {
    await consumeLinkCode({
      code: (await issueLinkCode(userId)).code,
      telegramUserId,
      telegramChatId,
      displayName: "Old account",
    });

    const newTelegramId = BigInt(77);
    const result = await consumeLinkCode({
      code: (await issueLinkCode(userId)).code,
      telegramUserId: newTelegramId,
      telegramChatId: newTelegramId,
      displayName: "New account",
    });

    expect(result.ok).toBe(true);
    expect(fake.links).toHaveLength(1);
    expect(fake.links[0]!.telegramUserId).toBe(newTelegramId);
  });

  it("re-links the same Telegram account to the same user", async () => {
    const first = await consumeLinkCode({
      code: (await issueLinkCode(userId)).code,
      telegramUserId,
      telegramChatId,
      displayName: "Jane",
    });
    const second = await consumeLinkCode({
      code: (await issueLinkCode(userId)).code,
      telegramUserId,
      telegramChatId,
      displayName: "Jane Doe",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fake.links).toHaveLength(1);
    expect(fake.links[0]!.displayName).toBe("Jane Doe");
  });

  it("keeps it to one link per Telegram identity across users", async () => {
    await consumeLinkCode({
      code: (await issueLinkCode(userId)).code,
      telegramUserId,
      telegramChatId,
      displayName: null,
    });

    // Same Telegram account, different Saale user  refused, not stolen.
    const result = await consumeLinkCode({
      code: (await issueLinkCode(otherUserId)).code,
      telegramUserId,
      telegramChatId,
      displayName: null,
    });

    expect(result).toEqual({ ok: false, reason: "already_linked" });
    expect(fake.links).toHaveLength(1);
    expect(fake.links[0]!.userId).toBe(userId);
  });
});

describe("link lookups", () => {
  beforeEach(() => {
    fake.codes.clear();
    fake.links.length = 0;
  });

  it("resolves the account a Telegram identity belongs to", async () => {
    await consumeLinkCode({
      code: (await issueLinkCode(userId)).code,
      telegramUserId,
      telegramChatId,
      displayName: "Jane",
    });

    const link = await getLinkByTelegramUserId(telegramUserId);
    expect(link?.userId).toBe(userId);
    expect(await getLinkByTelegramUserId(BigInt(999))).toBeNull();
  });

  it("caches the sender's display name against their own link only", async () => {
    await consumeLinkCode({
      code: (await issueLinkCode(userId)).code,
      telegramUserId,
      telegramChatId,
      displayName: "Jane",
    });
    await consumeLinkCode({
      code: (await issueLinkCode(otherUserId)).code,
      telegramUserId: BigInt(5),
      telegramChatId: BigInt(5),
      displayName: "Sam",
    });

    await updateLinkDisplayName(telegramUserId, "Jane Doe");

    expect((await getLinkByUserId(userId))?.displayName).toBe("Jane Doe");
    expect((await getLinkByUserId(otherUserId))?.displayName).toBe("Sam");
  });

  it("unlinks the user and drops any code they still hold", async () => {
    await consumeLinkCode({
      code: (await issueLinkCode(userId)).code,
      telegramUserId,
      telegramChatId,
      displayName: null,
    });
    await issueLinkCode(userId);

    expect(await unlinkUser(userId)).toBe(true);
    expect(await getLinkByUserId(userId)).toBeNull();
    expect(fake.codes.size).toBe(0);

    // Unlinking someone who was never linked reports nothing was removed.
    expect(await unlinkUser(userId)).toBe(false);
  });
});

describe("hashLinkCode", () => {
  it("is deterministic and never the plaintext", () => {
    const code = "abcDEF123_-abcDEF123_-abcDEF123_-ab";
    expect(hashLinkCode(code)).toBe(hashLinkCode(code));
    expect(hashLinkCode(code)).not.toBe(code);
    expect(hashLinkCode(code)).toHaveLength(64);
    expect(hashLinkCode(code)).not.toBe(hashLinkCode(`${code}x`));
  });
});
