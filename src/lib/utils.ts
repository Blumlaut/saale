import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Class list for an action attached to a list row (the row's ⋯ menu, a delete
 * button). Pointer devices get a quiet row whose action appears on hover or
 * keyboard focus; touch devices can never hover, so the action stays visible
 * there. otherwise it is simply unreachable on a phone.
 */
export const ROW_ACTION =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 any-pointer-coarse:opacity-100";

/** Format a byte count for display (e.g. 1536 → "1.5 KB"). */
export function formatFileSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ci cache smoke: run 1

// ci cache smoke: run 2
