/**
 * The trailer a coder chat puts on the commits it writes.
 *
 * An admin sets the line the instance wants, and the chat's id is filled in
 * here so one line can name the chat that made the commit. With the switch on
 * and no line of its own, a chat still says who wrote the commit and names the
 * workspace.
 *
 * No database import: the admin section reads these constants in the browser.
 */

import { normalizeWorkspaceName } from "@/lib/branding/workspace-name";

/** Where the chat's id goes in the admin's line. */
export const ATTRIBUTION_CHAT_PLACEHOLDER = "{chat}";

/** Room for a co-author line with a url, little enough to stay a trailer. */
export const MAX_ATTRIBUTION_LENGTH = 200;

export interface CommitAttributionSetting {
  enabled?: boolean | null;
  text?: string | null;
  /** The instance name, for a line that names nobody. */
  workspaceName?: string | null;
}

/** The line a chat's commits end with, or `null` when the admin turned it off. */
export function commitAttributionLine(
  setting: CommitAttributionSetting,
  chatId: string,
): string | null {
  if (!setting.enabled) return null;
  const text =
    (setting.text ?? "").trim() ||
    `Co-Authored-By: ${normalizeWorkspaceName(setting.workspaceName)}`;
  return text.replaceAll(ATTRIBUTION_CHAT_PLACEHOLDER, chatId);
}
