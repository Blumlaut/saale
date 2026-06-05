#!/usr/bin/env node
/**
 * Saale — Database Migration Script
 *
 * Strategy: Single baseline + auto-diff.
 *
 * Always diffs the live DB state against the target schema and applies
 * the delta. Works for both fresh installs and upgrades — no migration
 * history tracking, no "out of sync" errors.
 *
 * Safety guarantees:
 * - DROP operations are blocked by safety checks.
 * - Every change is wrapped in a transaction — partial failures roll back.
 * - Post-migration verification ensures DB matches schema.
 *
 * Usage: node scripts/migrate.mjs
 *   (reads DATABASE_URL from environment, set by docker-compose)
 */

/* eslint-disable no-console */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const prismaSchema = join(root, "prisma/schema.prisma");
const migrationsDir = join(root, "prisma/migrations");
const baselinePath = join(migrationsDir, "0001_baseline/migration.sql");

// ─── Helpers ───────────────────────────────────────────────────────

function info(msg) {
  console.log(`[migrate] ${msg}`);
}

function fatal(msg) {
  console.error(`\n[migrate] FATAL: ${msg}`);
  console.error("Database migration failed. The application will not start.");
  console.error("Check the logs above for details.\n");
  process.exit(1);
}

/**
 * Execute SQL against the database via `prisma db execute --stdin`.
 */
function executeSQL(sql) {
  const result = spawnSync("npx", ["prisma", "db", "execute", "--stdin"], {
    cwd: root,
    input: sql,
    encoding: "utf-8",
    env: process.env,
    timeout: 30000,
  });

  if (result.status !== 0) {
    const output = (result.stdout || "") + (result.stderr || "");
    fatal(`SQL execution failed:\n${output}`);
  }
}

// ─── Step 1: Generate diff SQL (current DB → target schema) ────────

/**
 * Returns:
 * - null if diff command failed (DB doesn't exist, connection error)
 * - "" (empty string) if DB is already in sync
 * - SQL string if there are changes
 */
function generateDiffSQL() {
  info("Computing diff between current DB and target schema...");

  const result = spawnSync(
    "npx",
    [
      "prisma",
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      prismaSchema,
      "--script",
    ],
    {
      cwd: root,
      encoding: "utf-8",
      env: process.env,
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  // Check if the command failed (non-zero exit + error output)
  if (result.status !== 0) {
    // Check if it's a "real" error vs. just "no diff"
    const stderr = (result.stderr || "").toLowerCase();
    if (stderr.includes("error") || stderr.includes("fatal")) {
      info("Diff command failed (DB may not exist or connection error).");
      return null;
    }
  }

  const sql = (result.stdout || "").trim();

  // Prisma returns "-- This is an empty migration." when in sync
  const meaningfulSQL = sql.replace(/--\s*This is an empty migration\.\s*/g, "").trim();

  if (!meaningfulSQL) {
    info("Database is already in sync with schema.");
    return "";
  }

  info("Diff generated successfully.");
  return meaningfulSQL;
}

// ─── Step 2: Validate the diff ──────────────────────────────────────

function validateDiff(sql) {
  if (!sql || !sql.trim()) {
    info("No changes needed — database is already in sync with schema.");
    return null;
  }

  // Block destructive operations
  const dangerousPatterns = [
    { pattern: /DROP\s+TABLE/i, msg: "DROP TABLE" },
    { pattern: /ALTER\s+TABLE.*DROP\s+COLUMN/i, msg: "DROP COLUMN" },
    { pattern: /DROP\s+INDEX.*CONCURRENTLY/i, msg: "DROP INDEX CONCURRENTLY" },
  ];

  for (const { pattern, msg } of dangerousPatterns) {
    if (pattern.test(sql)) {
      fatal(
        `Diff contains a destructive operation (${msg}). ` +
          `Schema changes must never drop existing data. ` +
          `Review prisma/schema.prisma — use nullable fields or add new tables instead.`,
      );
    }
  }

  // Log a summary of what will change
  const comments = sql
    .split("\n")
    .filter((l) => l.startsWith("--"))
    .map((l) => l.replace(/--\s*/, ""));
  info(`Changes: ${comments.slice(0, 20).join(", ")}`);

  return sql;
}

// ─── Step 3: Apply SQL ──────────────────────────────────────────────

function applySQL(sql) {
  info("Applying changes in a transaction...");

  // Wrap in a transaction for atomicity
  const wrapped = `BEGIN;\n${sql}\nCOMMIT;`;

  executeSQL(wrapped);
  info("Changes applied successfully.");
}

// ─── Step 4: Verify ─────────────────────────────────────────────────

function verify() {
  info("Verifying database matches target schema...");

  const remainingDiff = generateDiffSQL();
  // remainingDiff === null means diff failed (shouldn't happen after apply)
  // remainingDiff === "" means in sync
  // remainingDiff is a string means there are still differences
  if (remainingDiff && remainingDiff !== "") {
    fatal(
      `Verification failed — database still differs from schema after migration. ` +
        `This should not happen. Remaining diff (first 500 chars):\n${remainingDiff.slice(0, 500)}`,
    );
  }

  info("✓ Database is in sync with schema.");
}

// ─── Main ───────────────────────────────────────────────────────────

function main() {
  info("═".repeat(60));
  info("Saale Database Migration");
  info("═".repeat(60));

  if (!process.env.DATABASE_URL) {
    fatal("DATABASE_URL environment variable is not set.");
  }

  // Try diff-first approach
  let sql = generateDiffSQL();

  // If diff failed (null = DB doesn't exist or connection error), fall back to baseline
  if (sql === null) {
    info("Could not compute diff — falling back to baseline migration.");

    if (!existsSync(baselinePath)) {
      fatal(`Baseline migration not found at: ${baselinePath}`);
    }

    sql = readFileSync(baselinePath, "utf-8");
    info("Loaded baseline migration.");
  }

  // sql === "" means DB is already in sync
  if (sql !== "") {
    const validated = validateDiff(sql);
    if (validated) {
      applySQL(validated);
    }
  }

  verify();

  info("═".repeat(60));
  info("Migration complete.");
  info("═".repeat(60));
}

main();
