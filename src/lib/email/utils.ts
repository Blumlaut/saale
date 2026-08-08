/**
 * Strip null bytes and other invalid UTF-8 codepoints that PostgreSQL rejects.
 * Returns `null` for nullish/false inputs.
 */
export function sanitizePostgresString(str: unknown): string | null {
  if (str == null || str === false) return null;
  return String(str).replace(/\0/g, "");
}

/**
 * Parse a `to` field value that may be stored as a JSON string, array, or plain string.
 */
export function parseAddresses(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
      if (typeof parsed === "string") return [parsed];
    } catch {
      return [raw];
    }
  }
  return [];
}

/**
 * Split a comma-separated email address string into trimmed, non-empty parts.
 */
export function splitEmailAddresses(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
