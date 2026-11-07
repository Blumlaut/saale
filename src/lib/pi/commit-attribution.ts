/**
 * The trailer a coder chat puts on the commits it writes.
 *
 * The admin sets the line, naming `SAALE_*` variables in it. Saale fills those
 * in before the chat starts, so the prompt carries the finished line and the
 * agent writes it as plain text. Nothing downstream asks a shell to expand it.
 *
 * No database import: the admin section reads this module in the browser.
 */

import { DEFAULT_WORKSPACE_NAME } from "@/lib/branding/workspace-name";

/** Long enough for a co-author line with a url. */
export const MAX_ATTRIBUTION_LENGTH = 200;

/** The variables a line can name, and what each holds. */
export const ATTRIBUTION_VARIABLES = [
  { name: "SAALE_MODEL", what: "the model that answered in the chat" },
  { name: "SAALE_MODEL_PROVIDER", what: "the provider serving it" },
  { name: "SAALE_THINKING_LEVEL", what: "the thinking level it runs at" },
  { name: "SAALE_CHAT_ID", what: "the chat the commit belongs to" },
] as const;

/** The line a chat writes when the admin set none. */
export const DEFAULT_ATTRIBUTION_LINE = `Co-Authored-By: ${DEFAULT_WORKSPACE_NAME} ($SAALE_MODEL)`;

export interface CommitAttributionSetting {
  enabled?: boolean | null;
  text?: string | null;
}

/** The line a coder chat writes on every commit, or `null` when it is off. */
export function commitAttributionLine(setting: CommitAttributionSetting): string | null {
  if (!setting.enabled) return null;
  return (setting.text ?? "").trim() || DEFAULT_ATTRIBUTION_LINE;
}

/**
 * `line` with every `$NAME` replaced by its value.
 *
 * A name without a value stays as it was written, so a chat without a model
 * still shows the admin which variable went unfilled.
 */
export function resolveAttributionLine(
  line: string,
  values: Readonly<Record<string, string | null | undefined>>,
): string {
  return line.replace(/\$([A-Z][A-Z0-9_]*)/g, (match, name: string) => values[name] || match);
}
