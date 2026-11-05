import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  combinedTsquery,
  FUZZY_THRESHOLD,
  needsTrigramArm,
  parseSearchTerms,
  type SearchTerm,
} from "@/lib/search/terms";

/**
 * The postgres side of search: one row predicate and one relevance score built
 * from the arms in `terms.ts`, so every searchable table ranks the same way.
 *
 * Callers describe their columns and supply the raw SQL around them. See
 * `sources.ts` for the tables.
 */

/** A searchable column and how much a hit in it is worth. */
export interface SearchField {
  expr: Prisma.Sql;
  weight: number;
}

export interface SearchSpec {
  /** `FROM` clause with its alias, e.g. `"Contact" c`. */
  from: Prisma.Sql;
  /** Owner scoping and any filters. Never empty. */
  where: Prisma.Sql;
  fields: SearchField[];
  /**
   * Weighted tsvector of the searchable text. The migration indexes the same
   * expression, so this has to stay byte for byte what `sources.ts` declares.
   */
  tsvector: Prisma.Sql;
  /** Columns returned alongside `score`. */
  select: Prisma.Sql;
  /** Ordering used when there is no query. */
  orderBy: Prisma.Sql;
  limit: number;
  offset?: number;
}

/** Keeps one query from returning more than a caller could want. */
const MAX_RESULTS = 200;

/**
 * ts_rank scores a subject hit around 0.67 and a body hit around 0.24, while a
 * substring hit scores by its column weight. Scaling the full-text rank puts an
 * exact word in the subject above a fragment in the body.
 */
const FTS_SCORE_WEIGHT = 8;

function fieldMatches(field: SearchField, term: SearchTerm): Prisma.Sql[] {
  const arms = [Prisma.sql`${field.expr} ILIKE ${term.like}`];
  if (term.fuzzy) arms.push(Prisma.sql`${field.expr} %> ${term.text}`);
  return arms;
}

function fieldMatch(field: SearchField, term: SearchTerm): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(fieldMatches(field, term), " OR ")})`;
}

function fieldScore(field: SearchField, term: SearchTerm): Prisma.Sql {
  const arms = [Prisma.sql`CASE WHEN ${field.expr} ILIKE ${term.like} THEN 1 ELSE 0 END`];
  if (term.fuzzy) arms.push(Prisma.sql`word_similarity(${term.text}, ${field.expr})::float8`);
  return Prisma.sql`${field.weight}::float8 * GREATEST(${Prisma.join(arms, ", ")})`;
}

/** Every term has to appear somewhere in the row. */
function rowPredicate(terms: readonly SearchTerm[], spec: SearchSpec): Prisma.Sql {
  const perTerm = terms.map(
    (term) =>
      Prisma.sql`(${Prisma.join(
        spec.fields.map((field) => fieldMatch(field, term)),
        " OR ",
      )})`,
  );
  const tsquery = combinedTsquery(terms);

  if (!tsquery) return Prisma.sql`(${spec.where}) AND (${Prisma.join(perTerm, " AND ")})`;

  return Prisma.sql`(${spec.where}) AND ((
    ${spec.tsvector} @@ to_tsquery('english', ${tsquery})
  ) OR (${Prisma.join(perTerm, " AND ")}))`;
}

function scoreExpression(terms: readonly SearchTerm[], spec: SearchSpec): Prisma.Sql {
  const tsquery = combinedTsquery(terms);
  const parts: Prisma.Sql[] = [];

  if (tsquery) {
    parts.push(Prisma.sql`CASE WHEN ${spec.tsvector} @@ to_tsquery('english', ${tsquery})
      THEN ts_rank(${spec.tsvector}, to_tsquery('english', ${tsquery})) * ${FTS_SCORE_WEIGHT}::float8
      ELSE 0 END`);
  }

  for (const term of terms) {
    parts.push(
      Prisma.sql`GREATEST(${Prisma.join(
        spec.fields.map((field) => fieldScore(field, term)),
        ", ",
      )})`,
    );
  }

  return Prisma.sql`(${Prisma.join(parts, " + ")})`;
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(limit, MAX_RESULTS));
}

async function run(statement: Prisma.Sql, withTrigrams: boolean): Promise<unknown> {
  if (!withTrigrams) return prisma.$queryRaw(statement);

  // The trigram operator reads its threshold from the session, so keep the
  // change inside the transaction rather than leaking it into pooled queries.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT set_config(
      'pg_trgm.word_similarity_threshold', ${String(FUZZY_THRESHOLD)}, true
    )`);
    return tx.$queryRaw(statement);
  });
}

/**
 * The statement `searchRows` runs, plus whether it needs the trigram arm.
 * Exported so the fragments can be checked without a database.
 */
export function buildSearchQuery(
  query: string,
  spec: SearchSpec,
): { statement: Prisma.Sql; trigram: boolean } {
  const terms = parseSearchTerms(query);
  const offset = Math.max(0, spec.offset ?? 0);

  if (terms.length === 0) {
    return {
      statement: Prisma.sql`
        SELECT ${spec.select}, 0::float8 AS score
        FROM ${spec.from}
        WHERE ${spec.where}
        ORDER BY ${spec.orderBy}
        LIMIT ${boundedLimit(spec.limit)} OFFSET ${offset}
      `,
      trigram: false,
    };
  }

  return {
    statement: Prisma.sql`
      SELECT ${spec.select}, ${scoreExpression(terms, spec)} AS score
      FROM ${spec.from}
      WHERE ${rowPredicate(terms, spec)}
      ORDER BY score DESC, ${spec.orderBy}
      LIMIT ${boundedLimit(spec.limit)} OFFSET ${offset}
    `,
    trigram: needsTrigramArm(terms),
  };
}

/**
 * Rows matching every term in `query`, best first. An empty query falls back to
 * `spec.orderBy` with a score of zero.
 */
export async function searchRows<T>(
  query: string,
  spec: SearchSpec,
): Promise<Array<T & { score: number }>> {
  const { statement, trigram } = buildSearchQuery(query, spec);
  return (await run(statement, trigram)) as Array<T & { score: number }>;
}

/** How many rows the same query matches, for a paginated result. */
export async function countRows(query: string, spec: SearchSpec): Promise<number> {
  const terms = parseSearchTerms(query);

  if (terms.length === 0) {
    const rows = (await prisma.$queryRaw(Prisma.sql`
      SELECT count(*) AS count FROM ${spec.from} WHERE ${spec.where}
    `)) as Array<{ count: bigint }>;
    return Number(rows[0]?.count ?? 0);
  }

  const rows = (await run(
    Prisma.sql`SELECT count(*) AS count FROM ${spec.from} WHERE ${rowPredicate(terms, spec)}`,
    needsTrigramArm(terms),
  )) as Array<{ count: bigint }>;

  return Number(rows[0]?.count ?? 0);
}
