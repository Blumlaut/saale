import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { buildSearchQuery, type SearchSpec } from "@/lib/search/query";

vi.mock("@/lib/db", () => ({ prisma: {} }));

/** The statement with its parameters inlined as `?`, enough to read the shape. */
function text(statement: Prisma.Sql): string {
  return statement.strings.join("?").replace(/\s+/g, " ");
}

const spec: SearchSpec = {
  from: Prisma.sql`"Thing" t`,
  where: Prisma.sql`t."userId" = ${"user-1"}`,
  fields: [
    { expr: Prisma.sql`t.title`, weight: 3 },
    { expr: Prisma.sql`t.body`, weight: 1 },
  ],
  tsvector: Prisma.sql`(setweight(to_tsvector('english', coalesce(t.title, '')), 'A'))`,
  select: Prisma.sql`t.id, t.title`,
  orderBy: Prisma.sql`t."createdAt" DESC`,
  limit: 20,
};

describe("buildSearchQuery", () => {
  it("orders a plain listing by the caller's ordering, without a score", () => {
    const { statement, trigram } = buildSearchQuery("  ", spec);
    const sql = text(statement);

    expect(sql).toContain("0::float8 AS score");
    expect(sql).toContain('ORDER BY t."createdAt" DESC');
    expect(sql).not.toContain("ts_rank");
    expect(trigram).toBe(false);
  });

  it("requires every term to match", () => {
    const sql = text(buildSearchQuery("invoice march", spec).statement);
    const where = sql.slice(sql.indexOf("WHERE"), sql.indexOf("ORDER BY"));

    // Two terms: two parenthesised groups joined by AND, each covering both columns.
    expect(where).toContain(" AND ((");
    expect(where.split("ILIKE").length - 1).toBe(4);
  });

  it("matches a term as a substring, as a prefix lexeme, or as a near miss", () => {
    const sql = text(buildSearchQuery("invoices", spec).statement);

    expect(sql).toContain("t.title ILIKE ?");
    expect(sql).toContain("t.title %> ?");
    expect(sql).toContain("to_tsquery('english', ?)");
  });

  it("leaves the trigram arm out of a short term", () => {
    const { statement, trigram } = buildSearchQuery("car", spec);
    const sql = text(statement);

    expect(sql).not.toContain("%>");
    expect(sql).not.toContain("word_similarity");
    expect(trigram).toBe(false);
  });

  it("ranks the full-text hit above the column weight", () => {
    const sql = text(buildSearchQuery("invoice", spec).statement);

    expect(sql).toContain("ts_rank(");
    expect(sql).toContain("GREATEST(");
    expect(sql).toContain("AS score");
    expect(sql).toContain("ORDER BY score DESC");
  });

  it("keeps the owner filter on both count and rows", () => {
    const sql = text(buildSearchQuery("invoice", spec).statement);
    expect(sql).toContain('WHERE (t."userId" = ?)');
  });

  it("caps the page size whatever the caller asks for", () => {
    const sql = text(buildSearchQuery("invoice", { ...spec, limit: 10_000 }).statement);
    expect(sql).toContain("LIMIT ?");
    expect(buildSearchQuery("invoice", { ...spec, limit: 10_000 }).statement.values).toContain(200);
  });
});
