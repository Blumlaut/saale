/** Shared domain types used across multiple components. */

// --- Email ---

export interface EmailAccount {
  id: string;
  email: string;
  enabled: boolean;
  lastSyncedAt?: string | null;
  messageCount?: number;
  folders?: string[];
}

// --- Tasks / Jobs ---

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
