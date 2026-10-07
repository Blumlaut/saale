/** Shared domain types used across multiple components. */

// --- Email ---

export interface EmailAccount {
  id: string;
  email: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  enabled: boolean;
  lastSyncedAt?: string | null;
  /** Reason the last sync attempt failed; null once a sync succeeds. */
  lastSyncError?: string | null;
  lastSyncErrorAt?: string | null;
  messageCount?: number;
  folders?: string[];
}

// --- Jobs ---

export interface FieldDef {
  key: string;
  label: string;
  description?: string;
  type: "text" | "number" | "select" | "boolean";
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface JobSchema {
  type: string;
  label: string;
  description: string;
  icon?: string;
  defaultCron?: string;
  usesAi?: boolean;
  fields: FieldDef[];
}

// --- Agent Jobs ---

export interface AgentJobDefinition {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  systemPrompt: string | null;
  toolConfig: Record<string, boolean> | null;
  modelId: string | null;
  thinkingLevel: string;
  outputChannel: string | null;
  outputChannelId: string | null;
  cronExpression: string | null;
  runAt: string | null;
  lastRunAt: string | null;
  enabled: boolean;
  systemManaged: boolean;
  runCount: number;
  latestRun: { status: string; completedAt: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentJobRun {
  id: string;
  status: string;
  prompt: string;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  error: string | null;
  /** Set when the run produced output its configured channel could not deliver. */
  deliveryError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  messageCount: number;
  duration: number | null;
  createdAt: string;
}

export interface AgentJobMessage {
  id: string;
  role: string;
  content: string;
  thinking: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string | undefined;
    isError: boolean | undefined;
  }> | null;
  parentMessageId: string | null;
  createdAt: string;
}

// --- Tasks ---

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  tags: string[];
  order: number;
  source: string;
  sourceEmailId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- Calendar ---

export interface CalendarEvent {
  id: string;
  uid: string;
  calendarId: string;
  calendarName: string;
  calendarColor: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  dtStart: string;
  dtEnd: string | null;
  allDay: boolean;
  source: string;
}
