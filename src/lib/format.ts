/**
 * Shared display-formatting helpers.
 */

/**
 * Format a relative date ("just now", "2h ago", "yesterday", "Mar 15").
 */
export function formatRelativeDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return "";
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffH = diffMs / (1000 * 60 * 60);
    const diffD = diffMs / (1000 * 60 * 60 * 24);

    if (diffH < 1) return "just now";
    if (diffH < 24) return `${Math.floor(diffH)}h ago`;
    if (diffD < 2) return "yesterday";
    if (diffD < 7) return `${Math.floor(diffD)}d ago`;

    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/** Cut a string to `max` characters, marking the cut with an ellipsis. */
export function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/** Spell a count with its unit — `plural(1, "email", "emails")` → `"1 email"`. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
