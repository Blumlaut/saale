/**
 * What a variable name and value may be.
 *
 * A leaf module: an account's variables (`lib/sandbox/env.ts`) and the ones a
 * single MCP server carries (`lib/mcp/shared.ts`) are validated by the same
 * rules, and both are read from a client component as well as from a route.
 */

/**
 * `GH_TOKEN`, `NPM_CONFIG_TOKEN`: a shell-safe name, never a path or a command.
 *
 * The container spec writes variables as `NAME=value` entries, so anything a
 * shell would read differently has no way to arrive.
 */
const NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function isValidEnvName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** Why a name cannot be stored, or null when it can. */
export function envNameError(name: unknown): string | null {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    return "Variable names start with a letter or underscore and hold A-Z, 0-9 or _ (max 64 characters).";
  }
  return null;
}

/** Plaintext bytes a value occupies, counted the way the service counts them. */
export function envValueBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Why a value cannot be stored with that many bytes, or null when it can. */
export function envValueError(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return "A variable value must be text";
  if (value.includes("\0")) return "A variable value cannot contain a NUL byte";
  if (envValueBytes(value) > maxBytes) {
    return `A variable value cannot exceed ${maxBytes} bytes`;
  }
  return null;
}
