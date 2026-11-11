/**
 * A client for the database the app under test reads.
 *
 * Rows a spec needs (a long transcript, a mailbox) cannot be produced through
 * the app: the API that writes them starts a model run. Seeded rows are scoped
 * to the shared e2e account and removed again by the spec that made them.
 */

/** Run `fn` with a client for the app's database, closed afterwards. */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  await import("dotenv/config");
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("e2e: DATABASE_URL is not set  a seeded fixture needs the app's database");
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    return await fn(prisma as unknown as Db);
  } finally {
    await prisma.$disconnect();
  }
}

/** The handful of calls the fixtures below make. */
export interface Db {
  user: {
    findFirst: (args: {
      where: { email: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
    updateMany: (args: {
      where: { email: string };
      data: { role: string };
    }) => Promise<{ count: number }>;
  };
  chatMessage: {
    create: (args: Record<string, unknown>) => Promise<{ id: string }>;
    createMany: (args: { data: Record<string, unknown>[] }) => Promise<{ count: number }>;
    deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
  };
  emailAccount: {
    upsert: (args: {
      where: { userId_email: { userId: string; email: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      select: { id: true };
    }) => Promise<{ id: string }>;
    deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
  };
  emailMessage: {
    createMany: (args: { data: Record<string, unknown>[] }) => Promise<{ count: number }>;
    deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
  };
}
