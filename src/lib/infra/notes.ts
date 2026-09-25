/**
 * Shared types and constants for infrastructure machine notes.
 */

export const NOTE_CATEGORIES = [
  "general",
  "services",
  "paths",
  "credentials",
  "quirks",
  "config",
] as const;

export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export const DEFAULT_NOTE_CATEGORY: NoteCategory = "general";

export const NOTE_CATEGORY_LABELS: Record<NoteCategory, string> = {
  general: "General",
  services: "Services",
  paths: "Paths",
  credentials: "Credentials",
  quirks: "Quirks",
  config: "Config",
};

/** Human-readable label for a category; unknown values pass through. */
export function noteCategoryLabel(category: string): string {
  return NOTE_CATEGORY_LABELS[category as NoteCategory] ?? category;
}

/** Shape of a note as returned by /api/infra/machines/[id]/notes. */
export interface InfraNote {
  id: string;
  title: string;
  category: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
