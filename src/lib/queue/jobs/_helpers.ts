import type { FieldDef } from "@/lib/queue/job-schemas";

/**
 * Compute word overlap ratio between two titles.
 * Returns a value between 0 (no overlap) and 1 (identical words).
 */
export function titleWordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let matches = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) matches++;
  }

  // Overlap relative to the smaller set
  const minSize = Math.min(wordsA.size, wordsB.size);
  return matches / minSize;
}

/** Which email account a job reads, empty for every account the user has. */
export function emailAccountField(
  label = "Account",
  description = "Leave empty to process all accounts",
): FieldDef {
  return {
    key: "accountId",
    label,
    description,
    type: "select",
    default: "",
    options: [],
  };
}

/** How many emails one run takes. */
export function batchSizeField(options: {
  description: string;
  fallback: number;
  max: number;
}): FieldDef {
  return {
    key: "limit",
    label: "Batch size",
    description: options.description,
    type: "number",
    default: options.fallback,
    min: 1,
    max: options.max,
    step: 1,
  };
}

/** How old an email may be. 0 turns the age limit off. */
export function maxEmailAgeField(options: { verb: string; fallback: number }): FieldDef {
  return {
    key: "maxEmailAge",
    label: "Max email age",
    description: `Only ${options.verb} emails received within this many hours (0 = no limit)`,
    type: "number",
    default: options.fallback,
    min: 0,
    max: 720,
    step: 1,
  };
}

/** The model this job runs on, in place of the user's default. */
export function modelField(description = "Override the default model for this job"): FieldDef {
  return {
    key: "modelId",
    label: "AI Model",
    description,
    type: "model",
    default: "",
  };
}
