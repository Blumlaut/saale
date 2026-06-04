/**
 * Compute word overlap ratio between two titles.
 * Returns a value between 0 (no overlap) and 1 (identical words).
 */
export function titleWordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let matches = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) matches++;
  }

  // Overlap relative to the smaller set
  const minSize = Math.min(wordsA.size, wordsB.size);
  return matches / minSize;
}
