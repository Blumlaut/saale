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

// --- Contacts ---

export interface Contact {
  id: string;
  name: string;
  email: string;
  company: string | null;
  notes: string | null;
  lastSentAt: string | null;
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

// --- Script Watchers ---

/** A poll job: runs a script on a schedule and does something with what it reports. */
export interface ScriptWatcher {
  id: string;
  name: string;
  description: string | null;
  script: string;
  cronExpression: string;
  enabled: boolean;
  /** "chat" (answer in a conversation) | "silent" (the script delivers it) | "coder" (a project). */
  deliver: string;
  sessionId: string | null;
  sessionTitle: string | null;
  /** The project a "coder" fire dispatches into. */
  projectId: string | null;
  projectName: string | null;
  /** "per-fire" | "sticky". */
  worktreeMode: string;
  /** Minutes a finished per-fire bot chat is kept. */
  retentionMinutes: number;
  wakePrompt: string;
  modelId: string | null;
  cooldownMinutes: number;
  tickCount: number;
  fireCount: number;
  lastTickAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  lastValue: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One recorded tick of a watcher. */
export interface ScriptWatcherTick {
  id: string;
  /** "idle" | "fired" | "reported" | "cooldown" | "blocked" | "error" */
  status: string;
  value: string | null;
  error: string | null;
  output: string | null;
  durationMs: number;
  callCount: number;
  /** The tools the script called, so a tick says what delivered it. */
  toolNames?: string[];
  /** The chat this tick's fire was delivered into. */
  sessionId?: string | null;
  createdAt: string;
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

/** One calendar under an account, with how many events it holds. */
export interface CalendarAccountCalendar {
  id: string;
  name: string;
  color: string | null;
  enabled: boolean;
  remoteId?: string | null;
  lastSyncedAt?: string | null;
  eventCount: number;
}

/** A calendar account as the calendar API returns it, with the calendars under it. */
export interface CalendarAccountSummary {
  id: string;
  name: string;
  enabled: boolean;
  accountType?: string;
  serverUrl?: string | null;
  username?: string | null;
  lastSyncedAt?: string | null;
  calendars: CalendarAccountCalendar[];
}
