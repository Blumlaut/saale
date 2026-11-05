/**
 * Strip CR/LF characters so a value cannot add a header of its own.
 *
 * Every address, subject and display name that reaches an SMTP envelope goes
 * through here, in both the user's mail and the instance's.
 */
export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, "");
}
