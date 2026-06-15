/**
 * Schema definitions for job configuration fields.
 * Each job type declares what config fields it needs.
 * The frontend renders a dynamic form from these schemas.
 *
 * Schemas are derived from handler metadata in jobs/registry.ts.
 * This module re-exports them for backward compatibility.
 */

export type FieldType = "text" | "number" | "select" | "boolean" | "model" | "multiSelect";

export interface FieldDef {
  /** Key used in the config JSON */
  key: string;
  /** Human-readable label */
  label: string;
  /** Optional help text shown below the field */
  description?: string;
  /** Input type */
  type: FieldType;
  /** Default value (used when creating a new job) */
  default?: unknown;
  /** For select type: list of { value, label } options */
  options?: Array<{ value: string; label: string }>;
  /** For number type: minimum value */
  min?: number;
  /** For number type: maximum value */
  max?: number;
  /** For number type: step increment */
  step?: number;
}

export interface JobTypeSchema {
  /** Internal job type identifier */
  type: string;
  /** Display name */
  label: string;
  /** One-line description */
  description: string;
  /** Lucide icon name (imported dynamically) */
  icon: string;
  /** Default cron expression */
  defaultCron: string;
  /** Whether this job uses AI (needs model selection) */
  usesAi?: boolean;
  /** Configuration fields (excluding cronExpression which is always present) */
  fields: FieldDef[];
}

// Re-export from registry — single source of truth
import { jobTypeSchemas as _jobTypeSchemas } from "./jobs/registry";
export { _jobTypeSchemas as jobTypeSchemas };

/** Look up a schema by type */
export function getJobSchema(type: string): JobTypeSchema | undefined {
  return _jobTypeSchemas.find((s) => s.type === type);
}
