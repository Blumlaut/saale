/**
 * The trailer a coder chat puts on the commits it writes.
 *
 * The admin sets the line and a coder chat writes it verbatim, leaving the
 * `SAALE_*` variables Saale puts in its environment for the shell to expand at
 * commit time. Filling them in here would pin the model the chat started with,
 * and `/model` can change that mid-session.
 *
 * No database import: the admin section reads this module in the browser.
 */

import { DEFAULT_WORKSPACE_NAME } from "@/lib/branding/workspace-name";

/** Room for a co-author line with a url, little enough to stay a trailer. */
export const MAX_ATTRIBUTION_LENGTH = 200;

/** The variables a line can name, and what a commit is saying with each. */
export const ATTRIBUTION_VARIABLES = [
  { name: "SAALE_MODEL", what: "the model answering in the chat" },
  { name: "SAALE_MODEL_PROVIDER", what: "the provider serving that model" },
  { name: "SAALE_THINKING_LEVEL", what: "the thinking level it runs at" },
  { name: "SAALE_CHAT_ID", what: "the chat the commit belongs to" },
] as const;

/** What a chat writes when the switch is on and the admin left the line empty. */
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
