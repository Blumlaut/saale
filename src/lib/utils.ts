import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Class list for a hint attached to a row or card: a copy button, an open-link
 * arrow, something the row works without. It waits for hover or keyboard focus,
 * stays put while its menu is open, and is always visible on a device that
 * cannot hover. Row actions themselves are visible; their menu sits beside the
 * row, not behind a hover.
 */
export const ROW_ACTION =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 any-pointer-coarse:opacity-100 data-popup-open:opacity-100";

/** Format a byte count for display (e.g. 1536 → "1.5 KB", 20 GB → "20.1 GB"). */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
