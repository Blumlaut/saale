/**
 * Request validation for the council API.
 *
 * Zod at the edge, so a bad body is rejected with a message the room UI can show
 * rather than reaching the loop as a half-configured run.
 *
 * Two things are worth knowing when reading these schemas:
 * - `null` and `0` mean different things for a budget: null is "use the default
 *   for this level", 0 is "no ceiling at all" (see `resolveRunBudget`).
 * - A member's `name` may be omitted or blank: the server then assigns one from
 *   the bundled wordlist, so an unnamed agent is still addressable by `@name`.
 */

import { z } from "zod";
import {
  MAX_BRIEF_LENGTH,
  MAX_COUNCIL_NAME_LENGTH,
  MAX_COST_USD,
  MAX_MEMBER_NAME_LENGTH,
  MAX_MEMBERS,
  MAX_MESSAGE_LENGTH,
  MIN_MEMBERS,
} from "./config";
import { isValidMemberName, normalizeMemberName } from "./mentions";

/** A budget ceiling: null/absent inherits, 0 means unlimited. */
const nullableSeconds = z
  .number()
  .int()
  .min(0)
  .max(24 * 60 * 60)
  .nullish();
const nullableTokens = z.number().int().min(0).max(1_000_000_000).nullish();
const nullableCost = z.number().min(0).max(MAX_COST_USD).nullish();

const toolConfig = z.record(z.string().min(1).max(64), z.boolean()).nullish();

const memberName = z
  .string()
  .trim()
  .max(MAX_MEMBER_NAME_LENGTH)
  .refine((value) => value === "" || isValidMemberName(value), {
    message: "A name must be one word of letters, digits, - and _ (not user/all/system)",
  })
  .transform(normalizeMemberName);

export const memberInputSchema = z.object({
  name: memberName.optional(),
  instructions: z.string().trim().max(2000).nullish(),
  modelProvider: z.string().trim().max(64).nullish(),
  modelName: z.string().trim().max(200).nullish(),
  thinkingLevel: z.string().trim().max(32).optional(),
  toolConfig,
  enabled: z.boolean().optional(),
});

export const councilCreateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_COUNCIL_NAME_LENGTH),
  brief: z.string().trim().min(1).max(MAX_BRIEF_LENGTH),
  orchestration: z.enum(["parallel", "round-robin"]).default("parallel"),
  stopVoteThreshold: z.enum(["majority", "unanimous", "any"]).default("majority"),
  toolConfig,
  maxDurationSeconds: nullableSeconds,
  maxTokens: nullableTokens,
  maxCostUsd: nullableCost,
  members: z.array(memberInputSchema).min(MIN_MEMBERS).max(MAX_MEMBERS),
});

export const councilUpdateSchema = councilCreateSchema.omit({ members: true }).partial().extend({
  // Budgets may be cleared back to "no ceiling", which is 0, not null.
  maxDurationSeconds: nullableSeconds,
  maxTokens: nullableTokens,
  maxCostUsd: nullableCost,
});

export const councilRunSchema = z.object({
  maxDurationSeconds: nullableSeconds,
  maxTokens: nullableTokens,
  maxCostUsd: nullableCost,
  /** Members the opening message addressed; omitted wakes everyone. */
  memberIds: z.array(z.string().min(1)).max(MAX_MEMBERS).nullish(),
});

export const councilMessageSchema = z.object({
  content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  /**
   * Start a run from this message. The room's composer sends true; a note typed
   * into a paused room sends false and the run continues when the owner is ready.
   */
  startRun: z.boolean().default(true),
});

export type CouncilCreateInput = z.infer<typeof councilCreateSchema>;
export type CouncilUpdateInput = z.infer<typeof councilUpdateSchema>;
export type MemberInput = z.infer<typeof memberInputSchema>;
export type CouncilRunInput = z.infer<typeof councilRunSchema>;

/** Format a zod failure for an API response. */
export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
