import type { LucideIcon } from "lucide-react";
import type { ToolCallData } from "./types";
import type { ToolStatus } from "./tool-status";

/**
 * The contract between a tool and the one card that renders it.
 *
 * A card is described, never written: a descriptor is a pure function from a
 * tool call to this model, and `ToolCard` renders any model. Nothing below
 * knows a tool name, so adding a tool means writing data — and every card gets
 * the same header, badge, expander and spacing for free.
 */

/** Badge hue. `neutral` for metadata, `accent` for the app's mission colour. */
export type ToolTone = "neutral" | "info" | "warn" | "danger" | "accent" | "violet";

/**
 * The mark before a row's text. `avatar` carries its own already-computed
 * label and colour, `favicon` its image URL, so a descriptor stays pure data.
 */
export type ToolRowLeading =
  | { kind: "icon"; icon: LucideIcon }
  | { kind: "avatar"; label: string; color: string }
  | { kind: "favicon"; url: string };

/** Inline marks after a row's title. */
export type ToolRowMark = "dot" | "star";

/** Trailing details on a row's last line. */
export type ToolRowMeta =
  | { kind: "text"; text: string; mono?: boolean; icon?: LucideIcon }
  | { kind: "badge"; text: string; tone?: ToolTone };

/** One row of a list block. */
export interface ToolRowModel {
  leading?: ToolRowLeading;
  title?: string;
  /** Secondary lines under the title (a mail subject and its preview). */
  lines?: readonly { text: string; muted?: boolean; clamp?: boolean }[];
  marks?: readonly ToolRowMark[];
  meta?: readonly ToolRowMeta[];
  /** Renders the row as a link to this URL. */
  href?: string;
  /** Left accent bar colour, e.g. a calendar's colour. */
  accent?: string;
}

/** One labelled detail line of a `facts` block. */
export interface ToolFact {
  icon: LucideIcon;
  text: string;
  mono?: boolean;
  /** Muted trailing detail, e.g. a line number. */
  note?: string;
  badge?: { text: string; tone?: ToolTone };
}

/** A piece of a card's body. */
export type ToolCardBlock =
  | {
      kind: "rows";
      items: readonly ToolRowModel[];
      /** Rows shown before the "show more" control. */
      max?: number;
      /** Shown in place of the rows when `items` is empty. */
      empty?: string;
    }
  | { kind: "facts"; items: readonly ToolFact[] }
  /** A command's captured output — stdout and stderr share one box. */
  | { kind: "output"; stdout: string; stderr: string }
  | { kind: "diff"; lines: readonly string[]; max?: number }
  | { kind: "code"; text: string; label?: string; tone?: "muted" | "danger"; max?: number }
  | { kind: "text"; text: string; mono?: boolean; clamp?: boolean; tone?: "muted" | "danger" }
  | { kind: "badges"; items: readonly string[] };

/** Everything one tool call renders. */
export interface ToolCardModel {
  icon: LucideIcon;
  title: string;
  /** One-line context beside the title — the command, query, path or title. */
  detail?: string;
  status: ToolStatus;
  /** Header link, e.g. the page a `web_fetch` opened. */
  action?: { href: string; label: string };
  /** Open on first render. Result-shaped cards default to open at the call site. */
  defaultOpen?: boolean;
  /** The body. An empty or missing list means a header-only card. */
  blocks?: readonly ToolCardBlock[];
}

/**
 * A tool family's card, in model form.
 *
 * `names` and `prefixes` are how the registry finds it — `prefixes` covers a
 * whole family (every `infra_*` tool) behind one descriptor.
 */
export interface ToolDescriptor {
  names?: readonly string[];
  prefixes?: readonly string[];
  /** The model, or null when the result carries nothing this descriptor reads. */
  describe: (toolCall: ToolCallData) => ToolCardModel | null;
}
