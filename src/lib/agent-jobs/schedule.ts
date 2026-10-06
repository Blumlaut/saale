/**
 * One-off scheduling helpers for agent jobs.
 *
 * An agent job runs either on a cron expression (recurring) or at a single
 * `runAt` timestamp (one-off, e.g. a reminder). The queue prefers `runAt` when
 * both are set; these helpers keep the two fields mutually exclusive at the
 * API and tool boundaries so the stored definition matches what will run.
 */

/** Parse a client-supplied `runAt` value into a Date, or null when unset. */
export function normalizeRunAt(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Invalid runAt date");
    return value;
  }
  if (typeof value !== "string") {
    throw new Error("runAt must be an ISO 8601 date string");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid runAt date "${value}"`);
  }
  return parsed;
}
