/**
 * The shape of one ⌘K palette row.
 *
 * Browser-safe on purpose: the sidebar renders these rows, so nothing here may
 * reach the database. The searching stays in `palette.ts`.
 */

/** Everything the palette can find. */
export const PALETTE_KINDS = [
  "chat",
  "email",
  "contact",
  "task",
  "event",
  "memory",
  "automation",
  "server",
] as const;

/** Rows the palette shows when the caller names no limit. */
export const DEFAULT_PALETTE_LIMIT = 12;

/** Ceiling on one palette answer, however many sources it asked. */
export const MAX_PALETTE_LIMIT = 50;

export type PaletteKind = (typeof PALETTE_KINDS)[number];

export interface PaletteResult {
  kind: PaletteKind;
  id: string;
  title: string;
  /** One line of context: the matched excerpt, an address, a state. */
  snippet: string;
  score: number;
  /** Where the row goes, decided next to the result so the palette only navigates. */
  href: string;
}

/** The word the row's badge shows. */
export const PALETTE_KIND_LABELS: Record<PaletteKind, string> = {
  chat: "chat",
  email: "email",
  contact: "contact",
  task: "task",
  event: "event",
  memory: "memory",
  automation: "automation",
  server: "server",
};

/** The word the filter chip shows, where a plural reads better than a badge. */
export const PALETTE_KIND_CHIP_LABELS: Record<PaletteKind, string> = {
  chat: "Chats",
  email: "Mail",
  contact: "Contacts",
  task: "Tasks",
  event: "Events",
  memory: "Memories",
  automation: "Automations",
  server: "Servers",
};

/** The kinds a `?type=` value asks for. An absent or "all" value asks for every one. */
export function paletteKindsFrom(value: string | null): PaletteKind[] {
  if (!value || value === "all") return [...PALETTE_KINDS];
  const wanted = new Set(value.split(",").map((part) => part.trim()));
  return PALETTE_KINDS.filter((kind) => wanted.has(kind));
}
