/** Deterministic color for a tag string — maps to a small palette */
const tagColors: readonly string[] = [
  "bg-violet-500/10 text-violet-600 dark:bg-violet-400/10 dark:text-violet-400",
  "bg-sky-500/10 text-sky-600 dark:bg-sky-400/10 dark:text-sky-400",
  "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400",
  "bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400",
  "bg-rose-500/10 text-rose-600 dark:bg-rose-400/10 dark:text-rose-400",
  "bg-indigo-500/10 text-indigo-600 dark:bg-indigo-400/10 dark:text-indigo-400",
  "bg-teal-500/10 text-teal-600 dark:bg-teal-400/10 dark:text-teal-400",
  "bg-orange-500/10 text-orange-600 dark:bg-orange-400/10 dark:text-orange-400",
];

/**
 * Return a deterministic Tailwind color class for a tag name.
 * Same tag always gets the same color across sessions.
 */
export function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) & 0xffff;
  }
  const color = tagColors[hash % tagColors.length];
  return color ?? tagColors[0]!;
}

/**
 * Collect unique tags with message counts from a list of messages.
 * Returns entries sorted by count descending.
 */
export function collectTags<T extends { tags: string[] }>(
  messages: T[],
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    for (const t of msg.tags) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
