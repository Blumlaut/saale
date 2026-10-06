/**
 * Tool-call redaction for public share links.
 *
 * A `/share/<token>` URL is world-readable, so everything a tool call carries —
 * absolute paths, hostnames and SSH users, command output, file contents and
 * diffs, mail, calendar entries, memory hits, other chats — must be removed
 * before the payload is serialized. Redaction therefore happens here, on the
 * server: filtering in the share viewer would still ship the raw results to an
 * anonymous browser, where they are one devtools tab away.
 *
 * The policy is an allow-list. A tool with no entry below is not "safe by
 * default" — its arguments and result are dropped like every other tool's, and
 * only `redacted` (built from text this file owns, plus a handful of numeric
 * counts) crosses the boundary. A new tool therefore cannot leak by omission.
 *
 * Owner-facing chats are untouched: this is only called by the share endpoints.
 */

/** The persisted shape redaction reads — a subset of `SavedToolCall`. */
export interface RedactableToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string | undefined;
  isError: boolean | undefined;
}

/** A tool call safe to render on a public share page. */
export interface RedactedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: undefined;
  error: undefined;
  isError: boolean | undefined;
  /** The only detail a share page shows — never derived from the result body. */
  redacted: string;
}

interface SummaryRule {
  text: string;
  /**
   * Appends "· N <one|many>" when the tool's meta block carries this numeric
   * field. Both forms are spelled out — deriving one from the other gets
   * "matches" wrong.
   */
  count?: { field: string; one: string; many: string };
}

/**
 * One line per tool. Text is written by hand so nothing is copied out of a
 * result — only the optional count is read from the tool's own metadata.
 *
 * Every tool in `ALL_TOOL_INFOS` needs an entry; a test fails when a new tool
 * lands without one, so the summary is always a decision rather than a fallback.
 * (The fallback below still holds the line if one slips through.)
 */
const SUMMARY_RULES: Record<string, SummaryRule> = {
  // Pi terminal built-ins
  read: { text: "Read a file" },
  write: { text: "Wrote a file" },
  edit: { text: "Edited a file" },
  bash: { text: "Ran a shell command" },
  grep: { text: "Searched file contents" },
  ls: { text: "Listed a directory" },
  glob: { text: "Listed matching files" },

  // Saale
  codemode: { text: "Ran a script" },
  show_file: { text: "Shared a file" },
  web_search: {
    text: "Searched the web",
    count: { field: "count", one: "result", many: "results" },
  },
  web_fetch: { text: "Fetched a web page" },
  mail_list: { text: "Listed mail", count: { field: "count", one: "email", many: "emails" } },
  mail_search: {
    text: "Searched mail",
    count: { field: "count", one: "match", many: "matches" },
  },
  mail_read: { text: "Read mail", count: { field: "count", one: "email", many: "emails" } },
  mail_draft: { text: "Drafted mail" },
  mail_send: { text: "Sent mail" },
  mail_accounts: { text: "Listed mail accounts" },
  mail_folders: { text: "Listed mail folders" },
  mail_move: { text: "Moved mail" },
  mail_tag: { text: "Tagged mail" },
  mail_delete: { text: "Deleted mail" },
  mail_sync: { text: "Synced mail" },
  calendar_list: { text: "Listed calendars" },
  calendar_upcoming: {
    text: "Checked the calendar",
    count: { field: "count", one: "event", many: "events" },
  },
  calendar_search: {
    text: "Searched the calendar",
    count: { field: "count", one: "event", many: "events" },
  },
  calendar_create: { text: "Created a calendar event" },
  calendar_update: { text: "Updated a calendar event" },
  calendar_delete: { text: "Deleted a calendar event" },
  infra_exec: { text: "Ran a command in the terminal" },
  infra_list_machines: {
    text: "Listed servers",
    count: { field: "count", one: "server", many: "servers" },
  },
  infra_add_machine: { text: "Added a server" },
  infra_remove_machine: { text: "Removed a server" },
  infra_read_file: { text: "Read a file on a server" },
  infra_write_file: { text: "Wrote a file on a server" },
  infra_edit_file: { text: "Edited a file on a server" },
  infra_notes_list: {
    text: "Listed server notes",
    count: { field: "count", one: "note", many: "notes" },
  },
  infra_notes_get: { text: "Read a server note" },
  infra_notes_upsert: { text: "Saved a server note" },
  infra_notes_delete: { text: "Deleted a server note" },
  memory_search: {
    text: "Searched memory",
    count: { field: "count", one: "memory", many: "memories" },
  },
  memory_index: { text: "Updated memory" },
  memory_delete: { text: "Deleted memory" },
  model_list: { text: "Listed models" },
  task_create: { text: "Created a task" },
  task_update: { text: "Updated a task" },
  task_delete: { text: "Deleted a task" },
  task_search: {
    text: "Searched tasks",
    count: { field: "count", one: "match", many: "matches" },
  },
  task_list_pending: {
    text: "Listed pending tasks",
    count: { field: "count", one: "task", many: "tasks" },
  },
  job_create: { text: "Created a job" },
  job_update: { text: "Updated a job" },
  job_delete: { text: "Deleted a job" },
  job_enable: { text: "Enabled a job" },
  job_run: { text: "Ran a job" },
  job_logs: { text: "Read job logs" },
  job_list: { text: "Listed jobs", count: { field: "count", one: "job", many: "jobs" } },
  job_types: { text: "Listed job types" },
  agent_job_create: { text: "Created an agent job" },
  agent_job_update: { text: "Updated an agent job" },
  agent_job_delete: { text: "Deleted an agent job" },
  agent_job_run: { text: "Ran an agent job" },
  agent_job_logs: { text: "Read agent job logs" },
  agent_job_run_messages: { text: "Read agent job messages" },
  agent_job_list: {
    text: "Listed agent jobs",
    count: { field: "count", one: "job", many: "jobs" },
  },
  chat_search: { text: "Searched your other chats" },
  chat_respond: { text: "Sent a message to another chat" },
  chat_create: { text: "Started another chat" },
  chat_delete: { text: "Deleted another chat" },
};

const UNKNOWN_TOOL_SUMMARY: SummaryRule = { text: "Ran a tool" };

/**
 * Meta blocks the tools append to their result text. Must stay in sync with
 * the `_saale*Meta` blocks in `src/lib/pi/tools/`.
 */
const META_KEYS = ["_saaleWebMeta", "_saaleMailMeta", "_saaleCalMeta", "_saaleInfraMeta"] as const;

/**
 * Parse the metadata block a tool appended to its result text.
 *
 * The block is the last JSON object in the string, so the scan starts at the
 * key and walks back to its opening brace. Only `count`-style scalars are ever
 * read from it — the object itself is never returned to a caller that could
 * forward it. Returns null when the tool appended nothing or malformed JSON.
 */
function extractMeta(result: string | undefined): Record<string, unknown> | null {
  if (!result) return null;

  for (const key of META_KEYS) {
    const keyIndex = result.lastIndexOf(`"${key}"`);
    if (keyIndex === -1) continue;

    const openBrace = result.lastIndexOf("{", keyIndex);
    if (openBrace === -1) continue;

    let depth = 0;
    for (let i = openBrace; i < result.length; i++) {
      if (result[i] === "{") depth++;
      else if (result[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(result.slice(openBrace, i + 1)) as Record<string, unknown>;
            const meta = parsed[key];
            if (meta && typeof meta === "object" && !Array.isArray(meta)) {
              return meta as Record<string, unknown>;
            }
          } catch (err) {
            console.error("Failed to parse tool meta block while redacting for share:", err);
          }
          break;
        }
      }
    }
  }

  return null;
}

/**
 * The one-line description a share page shows for a tool call.
 *
 * Reads nothing from the result except a numeric count, so a tool whose output
 * is entirely sensitive still produces a useful summary.
 */
export function summarizeToolCallForShare(name: string, result: string | undefined): string {
  const rule = SUMMARY_RULES[name] ?? UNKNOWN_TOOL_SUMMARY;
  if (!rule.count) return rule.text;

  const value = extractMeta(result)?.[rule.count.field];
  if (typeof value !== "number" || !Number.isFinite(value)) return rule.text;

  return `${rule.text} · ${value} ${value === 1 ? rule.count.one : rule.count.many}`;
}

/**
 * Strip a persisted tool call down to what a public share may show.
 *
 * Arguments are dropped wholesale rather than filtered: they carry paths,
 * queries, recipients and message bodies, and a public reader never needs one.
 * Errors are dropped too — the failing call's message routinely quotes the
 * path or command that caused it.
 */
export function redactToolCallForShare(toolCall: RedactableToolCall): RedactedToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    args: {},
    result: undefined,
    error: undefined,
    isError: toolCall.isError,
    redacted: summarizeToolCallForShare(toolCall.name, toolCall.result),
  };
}

export function redactToolCallsForShare(toolCalls: RedactableToolCall[]): RedactedToolCall[] {
  return toolCalls.map(redactToolCallForShare);
}

/** Parse the persisted `toolCalls` column, tolerating a malformed value. */
export function parseStoredToolCalls(json: string | null | undefined): RedactableToolCall[] {
  if (!json) return [];

  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as RedactableToolCall[]) : [];
  } catch (err) {
    console.error("Failed to parse stored tool calls:", err);
    return [];
  }
}

/** Parse, redact and re-serialize the persisted `toolCalls` column. */
export function redactStoredToolCalls(json: string | null | undefined): string | null {
  const redacted = redactToolCallsForShare(parseStoredToolCalls(json));
  return redacted.length > 0 ? JSON.stringify(redacted) : null;
}
