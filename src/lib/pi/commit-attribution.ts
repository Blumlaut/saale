/**
 * The trailer a coder chat puts on the commits it writes.
 *
 * The admin sets the line; a coder chat writes it verbatim, and the shell
 * expands the `SAALE_*` variables Saale exports for the command.
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
