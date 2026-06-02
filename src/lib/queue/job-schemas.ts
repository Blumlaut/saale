/**
 * Schema definitions for job configuration fields.
 * Each job type declares what config fields it needs.
 * The frontend renders a dynamic form from these schemas.
 */

export type FieldType = "text" | "number" | "select" | "boolean" | "model";

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

/**
 * Registry of all job type schemas.
 * Source of truth — both the worker and the UI derive config from here.
 */
export const jobTypeSchemas: JobTypeSchema[] = [
  {
    type: "email_sync",
    label: "Email Sync",
    description: "Sync emails from connected IMAP accounts",
    icon: "RefreshCw",
    defaultCron: "*/30 * * * *",
    usesAi: false,
    fields: [
      {
        key: "accountId",
        label: "Account",
        description: "Leave empty to sync all enabled accounts",
        type: "select",
        default: "",
        options: [], // populated at runtime from DB
      },
    ],
  },
  {
    type: "summarization",
    label: "Email Summarization",
    description: "Generate AI summaries for new emails",
    icon: "FileText",
    defaultCron: "0 */6 * * *",
    usesAi: true,
    fields: [
      {
        key: "accountId",
        label: "Account",
        description: "Leave empty to process all accounts",
        type: "select",
        default: "",
        options: [], // populated at runtime from DB
      },
      {
        key: "limit",
        label: "Batch size",
        description: "Number of emails to process per run",
        type: "number",
        default: 10,
        min: 1,
        max: 100,
        step: 1,
      },
      {
        key: "maxEmailAge",
        label: "Max email age",
        description: "Only process emails received within this many hours (0 = no limit)",
        type: "number",
        default: 24,
        min: 0,
        max: 720,
        step: 1,
      },
      {
        key: "modelId",
        label: "AI Model",
        description: "Override the default model for this task",
        type: "model",
        default: "",
      },
    ],
  },
  {
    type: "classification",
    label: "Classification + Tags",
    description: "Auto-tag incoming emails with AI categories",
    icon: "Tags",
    defaultCron: "0 */6 * * *",
    usesAi: true,
    fields: [
      {
        key: "accountId",
        label: "Account",
        description: "Leave empty to process all accounts",
        type: "select",
        default: "",
        options: [], // populated at runtime from DB
      },
      {
        key: "limit",
        label: "Batch size",
        description: "Number of emails to process per run",
        type: "number",
        default: 10,
        min: 1,
        max: 100,
        step: 1,
      },
      {
        key: "maxEmailAge",
        label: "Max email age",
        description: "Only process emails received within this many hours (0 = no limit)",
        type: "number",
        default: 24,
        min: 0,
        max: 720,
        step: 1,
      },
      {
        key: "modelId",
        label: "AI Model",
        description: "Override the default model for this task",
        type: "model",
        default: "",
      },
    ],
  },
  {
    type: "spam_filtering",
    label: "Spam Filtering",
    description: "Evaluate spam score and move flagged emails",
    icon: "Shield",
    defaultCron: "0 */4 * * *",
    usesAi: true,
    fields: [
      {
        key: "accountId",
        label: "Account",
        description: "Leave empty to process all accounts",
        type: "select",
        default: "",
        options: [], // populated at runtime from DB
      },
      {
        key: "limit",
        label: "Batch size",
        description: "Number of emails to scan per run",
        type: "number",
        default: 20,
        min: 1,
        max: 200,
        step: 1,
      },
      {
        key: "spamThreshold",
        label: "Spam threshold",
        description: "Score above which emails are moved to Spam (0–1)",
        type: "number",
        default: 0.85,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: "maxEmailAge",
        label: "Max email age",
        description: "Only process emails received within this many hours (0 = no limit)",
        type: "number",
        default: 24,
        min: 0,
        max: 720,
        step: 1,
      },
      {
        key: "modelId",
        label: "AI Model",
        description: "Override the default model for this task",
        type: "model",
        default: "",
      },
    ],
  },
  {
    type: "calendar_sync",
    label: "Calendar Sync",
    description: "Sync events from connected CalDAV accounts",
    icon: "Calendar",
    defaultCron: "*/15 * * * *",
    usesAi: false,
    fields: [
      {
        key: "accountId",
        label: "Account",
        description: "Leave empty to sync all enabled accounts",
        type: "select",
        default: "",
        options: [], // populated at runtime from DB
      },
    ],
  },
  {
    type: "email_to_calendar",
    label: "Email → Calendar",
    description: "Scan emails for appointment-like content and create calendar events",
    icon: "CalendarPlus",
    defaultCron: "0 */4 * * *",
    usesAi: true,
    fields: [
      {
        key: "accountId",
        label: "Email Account",
        description: "Leave empty to scan all enabled email accounts",
        type: "select",
        default: "",
        options: [], // populated at runtime from email accounts
      },
      {
        key: "targetCalendarId",
        label: "Target Calendar",
        description: "Calendar to create events in (leave empty for default calendar)",
        type: "select",
        default: "",
        options: [], // populated at runtime from calendar accounts
      },
      {
        key: "limit",
        label: "Batch size",
        description: "Number of emails to scan per run",
        type: "number",
        default: 20,
        min: 1,
        max: 100,
        step: 1,
      },
      {
        key: "maxEmailAge",
        label: "Max email age",
        description: "Only scan emails received within this many hours (0 = no limit)",
        type: "number",
        default: 48,
        min: 0,
        max: 720,
        step: 1,
      },
      {
        key: "modelId",
        label: "AI Model",
        description: "Model used for event extraction",
        type: "model",
        default: "",
      },
    ],
  },
];

/** Look up a schema by type */
export function getJobSchema(type: string): JobTypeSchema | undefined {
  return jobTypeSchemas.find((s) => s.type === type);
}
