/**
 * Human-readable sizes for refusals and error messages.
 *
 * A limit the user cannot see is a bug report waiting to happen, so every
 * ceiling that produces a response says how big it is.
 */

/** `4 KB`, `2.5 MB`, `1.2 GB` — the unit a person would say out loud. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
