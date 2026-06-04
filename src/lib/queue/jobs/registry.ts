import type { JobTypeSchema } from "@/lib/queue/job-schemas";

// ─── Job Handlers ────────────────────────────────────────────────────────────
// Each handler exports: metadata, fields, handler(params)

import * as emailSync from "./email-sync";
import * as summarization from "./summarization";
import * as classification from "./classification";
import * as spamFiltering from "./spam-filtering";
import * as calendarSync from "./calendar-sync";
import * as emailToCalendar from "./email-to-calendar";
import * as subscriptionSync from "./subscription-sync";
import * as memoryExtraction from "./memory-extraction";
import * as memoryPruning from "./memory-pruning";
import * as chatTitleGeneration from "./chat-title-generation";

/** All registered job handlers, keyed by type. */
export const handlers = [
  emailSync,
  summarization,
  classification,
  spamFiltering,
  calendarSync,
  emailToCalendar,
  subscriptionSync,
  memoryExtraction,
  memoryPruning,
  chatTitleGeneration,
] as const;

/** Lookup map: type → handler module */
export const handlerMap = new Map(handlers.map((h) => [h.metadata.type, h])) as Map<
  string,
  (typeof handlers)[number]
>;

/**
 * Derive the job type schemas from handler metadata.
 * This is the single source of truth — UI forms, tool descriptions, and validation all derive from here.
 */
export const jobTypeSchemas: JobTypeSchema[] = handlers.map((h) => ({
  type: h.metadata.type,
  label: h.metadata.label,
  description: h.metadata.description,
  icon: h.metadata.icon,
  defaultCron: h.metadata.defaultCron,
  usesAi: h.metadata.usesAi,
  fields: h.fields,
}));
