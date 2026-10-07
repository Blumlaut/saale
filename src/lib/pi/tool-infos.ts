/**
 * Static catalog of all available tool names and descriptions.
 * Used by the settings UI to render per-tool policy selectors.
 * Client-safe — no server-only imports.
 *
 * MUST stay in sync with the actual tool definitions in src/lib/pi/tools/.
 */
import type { ToolCategoryKey } from "@/lib/pi/tool-categories";

export type ToolPolicy = "allow" | "auto" | "ask" | "off";

/** Whether a stored value is one of {@link ToolPolicy}. */
export function isToolPolicy(value: unknown): value is ToolPolicy {
  return value === "allow" || value === "auto" || value === "ask" || value === "off";
}

/**
 * What "auto" decides from the call itself, rather than from a name-level rule:
 * - infra_exec and bash: the command — safe ones (ls, cat, grep…) run, risky ones
 *   (rm, echo >>, sudo…) ask.
 * - codemode: the script — it asks only when the script reaches a tool that
 *   would ask on its own, so a script that only reads costs no click.
 * - Every other tool: behaves like "allow".
 */

/** Pi's tool for running a script that calls other tools (see codemode-approval.ts). */
export const CODEMODE_TOOL_NAME = "codemode";

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  /**
   * Which tool category this tool belongs to. Omitted for a tool no category
   * owns (`codemode` is active whatever categories are enabled, so a category
   * toggle would not govern it); the settings UI lists those tools on their own.
   */
  category?: ToolCategoryKey;
  /** Default approval policy for new users. */
  defaultPolicy: ToolPolicy;
  /**
   * Human-readable summary template for tool call notifications.
   * Uses {argName} placeholders resolved from the tool's arguments.
   * Omit if the tool doesn't need a summary (e.g. no-op list tools).
   * @example "{command} on {id}"
   * @example "reading {filePath}"
   */
  summaryTemplate?: string;
}

export const ALL_TOOL_INFOS: ToolInfo[] = [
  // ── Agent (not a category of its own) ─────────────────────────────
  {
    name: CODEMODE_TOOL_NAME,
    label: "Script",
    description: "Run one script that calls several tools at once",
    // Active whenever the session can call tools, whichever categories are on,
    // so it is listed on its own rather than under a category switch.
    defaultPolicy: "auto",
  },

  // ── Terminal (Pi built-ins) ───────────────────────────────────────
  {
    name: "read",
    label: "Read",
    description: "Read file contents",
    category: "terminal",
    defaultPolicy: "allow",
  },
  {
    name: "write",
    label: "Write",
    description: "Write content to a file",
    category: "terminal",
    defaultPolicy: "ask",
  },
  {
    name: "edit",
    label: "Edit",
    description: "Edit a file with targeted replacements",
    category: "terminal",
    defaultPolicy: "ask",
  },
  {
    name: "bash",
    label: "Bash",
    description: "Execute shell commands",
    category: "terminal",
    defaultPolicy: "auto",
  },
  {
    name: "show_file",
    label: "Show File",
    description: "Show a file as an attachment",
    // Ships with the terminal bundle (it reads through Open Terminal) and is
    // only available when terminal is configured, so it belongs to this
    // category — which also keeps it declared rather than behind codemode.
    category: "terminal",
    defaultPolicy: "allow",
  },

  // ── Chat ──────────────────────────────────────────────────────────
  {
    name: "chat_search",
    label: "Search Chat History",
    description: "Search through chat history by query",
    category: "chatSearch",
    defaultPolicy: "allow",
  },
  {
    name: "chat_respond",
    label: "Respond in Chat",
    description: "Send a message into a chat and get its reply",
    category: "chatSearch",
    defaultPolicy: "ask",
  },
  {
    name: "chat_create",
    label: "Start Chat",
    description: "Start a new chat and get its reply",
    category: "chatSearch",
    defaultPolicy: "ask",
  },
  {
    name: "chat_delete",
    label: "Delete Chat",
    description: "Permanently delete a chat and its messages",
    category: "chatSearch",
    defaultPolicy: "ask",
  },

  // ── Telegram ──────────────────────────────────────────────────────
  {
    name: "telegram_send",
    label: "Send Telegram Message",
    description: "Message the user on Telegram",
    category: "telegram",
    // Delivers to the user's own chat only, and is the one tool that can reach
    // them unattended (reminders run without an approval channel), so it must
    // not sit behind a prompt that nobody can answer.
    defaultPolicy: "allow",
    summaryTemplate: "Messaging the user on Telegram",
  },

  // ── Email ─────────────────────────────────────────────────────────
  {
    name: "mail_accounts",
    label: "List Email Accounts",
    description: "List connected email accounts",
    category: "email",
    defaultPolicy: "allow",
  },
  {
    name: "mail_folders",
    label: "List Folders",
    description: "List folders for an email account",
    category: "email",
    defaultPolicy: "allow",
  },
  {
    name: "mail_sync",
    label: "Sync Email Account",
    description: "Sync an email account to fetch new messages",
    category: "email",
    defaultPolicy: "allow",
    summaryTemplate: "Syncing mailbox",
  },
  {
    name: "mail_list",
    label: "List Emails",
    description: "List emails with filters",
    category: "email",
    defaultPolicy: "allow",
  },
  {
    name: "mail_read",
    label: "Read Email",
    description: "Read email content by ID",
    category: "email",
    defaultPolicy: "allow",
  },
  {
    name: "mail_search",
    label: "Search Emails",
    description: "Search emails by query",
    category: "email",
    defaultPolicy: "allow",
    summaryTemplate: 'Searching emails for "{query}"',
  },
  {
    name: "mail_send",
    label: "Send Email",
    description: "Send an email",
    category: "email",
    defaultPolicy: "ask",
  },
  {
    name: "mail_tag",
    label: "Tag Email",
    description: "Add or remove tags from emails",
    category: "email",
    defaultPolicy: "allow",
  },
  {
    name: "mail_move",
    label: "Move Email",
    description: "Move emails between folders",
    category: "email",
    defaultPolicy: "allow",
  },
  {
    name: "mail_delete",
    label: "Delete Email",
    description: "Permanently delete emails",
    category: "email",
    defaultPolicy: "ask",
  },

  // ── Jobs ──────────────────────────────────────────────────────────
  {
    name: "job_list",
    label: "List Jobs",
    description: "List all configured jobs",
    category: "jobs",
    defaultPolicy: "allow",
  },
  {
    name: "job_types",
    label: "List Job Types",
    description: "List available job types and their schemas",
    category: "jobs",
    defaultPolicy: "allow",
  },
  {
    name: "job_logs",
    label: "Job Logs",
    description: "View recent run history for a job",
    category: "jobs",
    defaultPolicy: "allow",
  },
  {
    name: "model_list",
    label: "List Models",
    description: "List available AI models",
    category: "jobs",
    defaultPolicy: "allow",
  },
  {
    name: "job_create",
    label: "Create Job",
    description: "Create a new scheduled job",
    category: "jobs",
    defaultPolicy: "allow",
  },
  {
    name: "job_update",
    label: "Update Job",
    description: "Update an existing job",
    category: "jobs",
    defaultPolicy: "allow",
  },
  {
    name: "job_enable",
    label: "Enable/Disable Job",
    description: "Enable or disable a job",
    category: "jobs",
    defaultPolicy: "allow",
  },
  {
    name: "job_run",
    label: "Run Job Now",
    description: "Trigger an immediate manual run of a job",
    category: "jobs",
    defaultPolicy: "ask",
  },
  {
    name: "job_delete",
    label: "Delete Job",
    description: "Permanently delete a job",
    category: "jobs",
    defaultPolicy: "ask",
  },

  // ── Calendar ──────────────────────────────────────────────────────
  {
    name: "calendar_list",
    label: "List Calendars",
    description: "List all connected calendars",
    category: "calendar",
    defaultPolicy: "allow",
  },
  {
    name: "calendar_upcoming",
    label: "Upcoming Events",
    description: "List upcoming calendar events",
    category: "calendar",
    defaultPolicy: "allow",
  },
  {
    name: "calendar_search",
    label: "Search Events",
    description: "Search calendar events by query",
    category: "calendar",
    defaultPolicy: "allow",
    summaryTemplate: 'Searching calendar for "{query}"',
  },
  {
    name: "calendar_create",
    label: "Create Event",
    description: "Create a calendar event",
    category: "calendar",
    defaultPolicy: "allow",
  },
  {
    name: "calendar_update",
    label: "Update Event",
    description: "Update a calendar event",
    category: "calendar",
    defaultPolicy: "allow",
  },
  {
    name: "calendar_delete",
    label: "Delete Event",
    description: "Delete a calendar event",
    category: "calendar",
    defaultPolicy: "ask",
  },

  // ── Web ───────────────────────────────────────────────────────────
  {
    name: "web_search",
    label: "Web Search",
    description: "Search the web",
    category: "web",
    defaultPolicy: "allow",
    summaryTemplate: 'Searching web for "{query}"',
  },
  {
    name: "web_fetch",
    label: "Fetch URL",
    description: "Fetch a web page",
    category: "web",
    defaultPolicy: "allow",
    summaryTemplate: "Fetching {url}",
  },

  // ── Memory ────────────────────────────────────────────────────────
  {
    name: "memory_index",
    label: "Memory Index",
    description: "List memory collections with sizes, tags and recent titles",
    category: "memory",
    defaultPolicy: "allow",
  },
  {
    name: "memory_search",
    label: "Search Memory",
    description: "Search saved memories",
    category: "memory",
    defaultPolicy: "allow",
    summaryTemplate: 'Searching memory for "{query}"',
  },
  {
    name: "memory_delete",
    label: "Delete Memory",
    description: "Permanently delete a memory",
    category: "memory",
    defaultPolicy: "ask",
  },

  // ── Tasks ─────────────────────────────────────────────────────────
  {
    name: "task_create",
    label: "Create Task",
    description: "Create a new task",
    category: "tasks",
    defaultPolicy: "allow",
  },
  {
    name: "task_update",
    label: "Update Task",
    description: "Update a task",
    category: "tasks",
    defaultPolicy: "allow",
  },
  {
    name: "task_list_pending",
    label: "List Pending Tasks",
    description: "List pending and overdue tasks",
    category: "tasks",
    defaultPolicy: "allow",
  },
  {
    name: "task_search",
    label: "Search Tasks",
    description: "Search tasks by query",
    category: "tasks",
    defaultPolicy: "allow",
  },
  {
    name: "task_delete",
    label: "Delete Task",
    description: "Permanently delete a task",
    category: "tasks",
    defaultPolicy: "ask",
  },

  // ── Agent Jobs ────────────────────────────────────────────────────
  {
    name: "agent_job_list",
    label: "List Agent Jobs",
    description: "List agent job definitions",
    category: "agentJobs",
    defaultPolicy: "allow",
  },
  {
    name: "agent_job_logs",
    label: "Agent Job Logs",
    description: "View recent agent job runs",
    category: "agentJobs",
    defaultPolicy: "allow",
  },
  {
    name: "agent_job_run_messages",
    label: "Agent Run Messages",
    description: "View conversation for a specific agent run",
    category: "agentJobs",
    defaultPolicy: "allow",
  },
  {
    name: "agent_job_create",
    label: "Create Agent Job",
    description: "Create a background agent job",
    category: "agentJobs",
    defaultPolicy: "ask",
  },
  {
    name: "agent_job_update",
    label: "Update Agent Job",
    description: "Update an agent job definition",
    category: "agentJobs",
    defaultPolicy: "allow",
  },
  {
    name: "agent_job_run",
    label: "Run Agent Job",
    description: "Trigger an immediate agent job run",
    category: "agentJobs",
    defaultPolicy: "ask",
  },
  {
    name: "agent_job_delete",
    label: "Delete Agent Job",
    description: "Delete an agent job and all its runs",
    category: "agentJobs",
    defaultPolicy: "ask",
  },

  // ── Infrastructure ────────────────────────────────────────────────
  {
    name: "infra_list_machines",
    label: "List Machines",
    description: "List registered remote machines",
    category: "infra",
    defaultPolicy: "allow",
  },
  {
    name: "infra_notes_list",
    label: "List Machine Notes",
    description: "List notes for a machine",
    category: "infra",
    defaultPolicy: "allow",
    summaryTemplate: "Listing notes for {machineName}",
  },
  {
    name: "infra_notes_get",
    label: "Get Machine Note",
    description: "Get the full content of a note",
    category: "infra",
    defaultPolicy: "allow",
  },
  {
    name: "infra_add_machine",
    label: "Add Machine",
    description: "Register a new remote machine",
    category: "infra",
    defaultPolicy: "ask",
    summaryTemplate: "Adding machine {name}",
  },
  {
    name: "infra_notes_upsert",
    label: "Upsert Machine Note",
    description: "Create or update a machine note",
    category: "infra",
    defaultPolicy: "allow",
    summaryTemplate: "Saving note on {machineName}",
  },
  {
    name: "infra_exec",
    label: "Execute Command",
    description: "Run a shell command on a remote machine",
    category: "infra",
    defaultPolicy: "auto",
    summaryTemplate: "Running {command} on {machineName}",
  },
  {
    name: "infra_read_file",
    label: "Read Remote File",
    description: "Read a file from a remote machine",
    category: "infra",
    defaultPolicy: "allow",
    summaryTemplate: "Reading {path} on {machineName}",
  },
  {
    name: "infra_write_file",
    label: "Write Remote File",
    description: "Write content to a file on a remote machine",
    category: "infra",
    defaultPolicy: "ask",
    summaryTemplate: "Writing to {path} on {machineName}",
  },
  {
    name: "infra_edit_file",
    label: "Edit Remote File",
    description: "Edit a file on a remote machine with targeted replacements",
    category: "infra",
    defaultPolicy: "ask",
    summaryTemplate: "Editing {path} on {machineName}",
  },
  {
    name: "infra_download_file",
    label: "Download Remote File",
    description: "Download a file from a remote machine into the workspace",
    category: "infra",
    defaultPolicy: "allow",
    summaryTemplate: "Downloading {path} from {machineName}",
  },
  {
    name: "infra_upload_file",
    label: "Upload File",
    description: "Upload a file from the workspace to a remote machine",
    category: "infra",
    defaultPolicy: "ask",
    summaryTemplate: "Uploading to {path} on {machineName}",
  },
  {
    name: "infra_notes_delete",
    label: "Delete Machine Note",
    description: "Delete a machine note",
    category: "infra",
    defaultPolicy: "allow",
  },
  {
    name: "infra_remove_machine",
    label: "Remove Machine",
    description: "Remove a registered machine and all its notes",
    category: "infra",
    defaultPolicy: "ask",
    summaryTemplate: "Removing machine {name}",
  },

  // ── Settings ──────────────────────────────────────────────────────
  {
    name: "settings_list",
    label: "List Settings",
    description: "List Saale settings and their current values",
    category: "settings",
    defaultPolicy: "allow",
  },
  {
    name: "settings_set",
    label: "Change Setting",
    description: "Change one Saale setting",
    category: "settings",
    // Changing a setting is consequential — it can widen the agent's own
    // permissions or rewrite the prompt. Ask unless the user opts out.
    defaultPolicy: "ask",
    summaryTemplate: "Changing setting {key}",
  },
];

/** Group tools by category key. */
export function getToolsByCategory(categoryKey: string): typeof ALL_TOOL_INFOS {
  return ALL_TOOL_INFOS.filter((t) => t.category === categoryKey);
}

/**
 * Tools no category owns. They are active regardless of the category switches,
 * so the settings UI lists them separately, with their policies and no toggle.
 */
export function getUncategorizedTools(): typeof ALL_TOOL_INFOS {
  return ALL_TOOL_INFOS.filter((t) => t.category === undefined);
}

/** Look up the default policy for a tool by name. */
export function getDefaultPolicy(toolName: string): ToolPolicy {
  return ALL_TOOL_INFOS.find((t) => t.name === toolName)?.defaultPolicy ?? "ask";
}

/**
 * Resolve `{key}` placeholders in a template string against an args object.
 *
 * Unknown or nullish keys are left as `{key}` in the output.
 *
 * @example resolveTemplate("Running {cmd} on {host}", { cmd: "ls", host: "prod" })
 *   → "Running ls on prod"
 */
export function resolveTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = args[key];
    if (value === undefined || value === null) return `{${key}}`;
    return typeof value === "string" ? value : String(value);
  });
}

/** Look up a tool's info entry (or `undefined` if not found). */
export function findToolInfo(toolName: string): ToolInfo | undefined {
  return ALL_TOOL_INFOS.find((t) => t.name === toolName);
}

/**
 * Resolve a tool's summary template against its arguments.
 *
 * Replaces `{argName}` placeholders with the corresponding arg value.
 * Returns `null` if the tool has no summary template defined.
 *
 * @example formatToolSummary("web_search", { query: "latest news" })
 *   → 'searching web for "latest news"'
 */
export function formatToolSummary(toolName: string, args: Record<string, unknown>): string | null {
  const info = findToolInfo(toolName);
  if (!info?.summaryTemplate) return null;

  return resolveTemplate(info.summaryTemplate, args);
}

// ─── Tool action description (approval dialog) ────────────────────────────────

/**
 * Friendly labels for tool arguments, per tool.
 * Args not listed here fall back to a humanized key ("dtStart" → "Dt start").
 */
export const TOOL_ARG_LABELS: Record<string, Record<string, string>> = {
  read: { path: "File" },
  write: { path: "File", content: "Content" },
  edit: { path: "File", edits: "Edits" },
  bash: { command: "Command" },
  show_file: { filePath: "File", description: "Note" },
  codemode: { code: "Script" },
  chat_respond: { sessionId: "Chat", message: "Message" },
  chat_create: { message: "Message", title: "Title" },
  chat_delete: { sessionId: "Chat" },
  mail_send: {
    to: "To",
    subject: "Subject",
    body: "Body",
    bodyHtml: "HTML body",
    replyTo: "Reply-to",
    attachments: "Attachments",
    accountId: "Account",
  },
  mail_read: { ids: "Emails" },
  mail_list: {
    accountId: "Account",
    folder: "Folder",
    unread: "Unread only",
    starred: "Starred only",
    since: "Since",
    until: "Until",
    limit: "Limit",
    offset: "Offset",
  },
  mail_search: { query: "Query", accountId: "Account", limit: "Limit" },
  mail_tag: { ids: "Emails", addTags: "Add tags", removeTags: "Remove tags" },
  mail_move: { ids: "Emails", folder: "To folder" },
  mail_delete: { ids: "Emails" },
  calendar_create: {
    calendarId: "Calendar",
    summary: "Title",
    dtStart: "Starts",
    dtEnd: "Ends",
    location: "Location",
    allDay: "All-day",
    timeZone: "Time zone",
    recurrenceRule: "Repeats",
  },
  calendar_update: {
    id: "Event",
    summary: "Title",
    dtStart: "Starts",
    dtEnd: "Ends",
    location: "Location",
    allDay: "All-day",
    timeZone: "Time zone",
  },
  calendar_delete: { id: "Event" },
  task_create: { title: "Title", priority: "Priority", dueDate: "Due", tags: "Tags" },
  task_update: {
    taskId: "Task",
    title: "Title",
    priority: "Priority",
    dueDate: "Due",
    tags: "Tags",
    status: "Status",
  },
  task_delete: { taskId: "Task" },
  job_create: { config: "Definition", modelId: "Model", enabled: "Enabled" },
  job_update: { id: "Job", modelId: "Model", enabled: "Enabled", config: "Definition" },
  job_enable: { id: "Job", enabled: "State" },
  job_run: { id: "Job" },
  job_logs: { id: "Job", limit: "Limit", status: "Status" },
  job_delete: { id: "Job" },
  agent_job_create: {
    name: "Name",
    prompt: "Prompt",
    systemPrompt: "System prompt",
    toolConfig: "Tools",
    modelId: "Model",
    outputChannel: "Output channel",
    outputChannelId: "Channel ID",
    cronExpression: "Schedule",
    runAt: "Runs at",
  },
  agent_job_update: {
    id: "Agent job",
    name: "Name",
    prompt: "Prompt",
    systemPrompt: "System prompt",
    toolConfig: "Tools",
    modelId: "Model",
    outputChannel: "Output channel",
    outputChannelId: "Channel ID",
    cronExpression: "Schedule",
    runAt: "Runs at",
    enabled: "Enabled",
  },
  agent_job_run: { id: "Agent job", prompt: "Prompt" },
  agent_job_logs: { id: "Agent job", limit: "Limit", status: "Status" },
  agent_job_run_messages: { runId: "Run" },
  agent_job_delete: { id: "Agent job" },
  infra_add_machine: {
    name: "Name",
    host: "Host",
    port: "Port",
    username: "User",
    authMethod: "Auth method",
    password: "Password",
  },
  infra_remove_machine: { id: "Machine" },
  infra_exec: { id: "Machine", command: "Command", timeout: "Timeout", cwd: "Working dir" },
  infra_read_file: { id: "Machine", path: "Path" },
  infra_write_file: { id: "Machine", path: "Path", content: "Content" },
  infra_edit_file: { id: "Machine", path: "Path", edits: "Edits" },
  infra_download_file: { id: "Machine", path: "Path", dest: "Destination" },
  infra_upload_file: { id: "Machine", path: "Path", source: "Source" },
  infra_notes_list: { id: "Machine", category: "Category" },
  infra_notes_get: { id: "Note" },
  infra_notes_upsert: {
    machineId: "Machine",
    title: "Title",
    content: "Content",
    category: "Category",
    id: "Note",
  },
  infra_notes_delete: { id: "Note" },
  web_search: { query: "Query" },
  web_fetch: { url: "URL" },
  memory_search: { query: "Query", collection: "Collection", tags: "Tags", limit: "Limit" },
  memory_delete: { id: "Memory" },
  settings_list: { key: "Setting" },
  settings_set: { key: "Setting", value: "New value" },
};

export interface ToolActionField {
  key: string;
  /** Friendly label (from TOOL_ARG_LABELS or a humanized key). */
  label: string;
  value: unknown;
}

export interface ToolAction {
  toolName: string;
  /** Friendly tool name, or the raw name for tools outside the catalog. */
  label: string;
  /** One-line "what it does" from the catalog; empty for unknown tools. */
  description: string;
  /**
   * One-line headline of the concrete call ("Send email to a@b — \"Subj\""),
   * or null when it cannot be derived from the arguments alone.
   */
  summary: string | null;
  fields: ToolActionField[];
  /** False for tools outside the catalog (e.g. MCP tools). */
  known: boolean;
}

/** Humanize a camelCase/snake_case key: "dtStart" → "Dt Start". */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Humanize an ISO date/datetime string.
 *
 * Datetimes at midnight ("date-only" values like due dates) print without a
 * time. Returns null when the value is not an ISO date string.
 */
export function formatDateTimeValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const dateOnly = date.toISOString().slice(11, 19) === "00:00:00";
  const datePart = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  if (dateOnly) return datePart;
  return `${datePart}, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** Join a short string list: "a, b" / "a, b and c" / "a, b and 2 more". */
function joinList(values: string[], maxItems = 3): string {
  if (values.length === 0) return "";
  if (values.length <= maxItems) {
    const rest = values.slice(0, -1).join(", ");
    const last = values[values.length - 1];
    return last ? `${rest ? rest + " and " : ""}${last}` : rest;
  }
  return `${values.slice(0, maxItems).join(", ")} and ${values.length - maxItems} more`;
}

type SummaryBuilder = (args: Record<string, unknown>) => string | null;

/**
 * Per-tool one-line summary builders for tools whose arguments alone make the
 * call clear — mostly the tools that sit behind approval by default.
 * Tools with a catalog `summaryTemplate` take precedence over these.
 */
const SUMMARY_BUILDERS: Record<string, SummaryBuilder> = {
  mail_send: (a) => {
    const to = Array.isArray(a.to) ? a.to.filter((v): v is string => typeof v === "string") : [];
    const subject = typeof a.subject === "string" ? a.subject : null;
    if (to.length === 0 && !subject) return null;
    return `Send email${to.length ? ` to ${joinList(to)}` : ""}${subject ? ` — \"${subject}\"` : ""}`;
  },
  mail_delete: (a) => {
    const count = Array.isArray(a.ids) ? a.ids.length : 0;
    return count ? `Delete ${count} email${count === 1 ? "" : "s"}` : null;
  },
  mail_tag: (a) => {
    const count = Array.isArray(a.ids) ? a.ids.length : 0;
    return count ? `Tag ${count} email${count === 1 ? "" : "s"}` : null;
  },
  mail_move: (a) => {
    const count = Array.isArray(a.ids) ? a.ids.length : 0;
    if (!count) return null;
    const folder = typeof a.folder === "string" ? a.folder : "";
    return `Move ${count} email${count === 1 ? "" : "s"}${folder ? ` to \"${folder}\"` : ""}`;
  },
  calendar_create: (a) => {
    const title = typeof a.summary === "string" ? a.summary : null;
    if (!title) return null;
    const start = formatDateTimeValue(a.dtStart);
    return `Create event \"${title}\"${start ? ` — ${start}` : ""}`;
  },
  calendar_update: (a) => {
    const title = typeof a.summary === "string" ? a.summary : null;
    return title ? `Update event \"${title}\"` : null;
  },
  calendar_delete: () => null, // id-only — resolved server-side (event title)
  task_create: (a) => {
    if (typeof a.title !== "string") return null;
    const due = formatDateTimeValue(a.dueDate);
    return `Create task \"${a.title}\"${due ? ` (due ${due})` : ""}`;
  },
  task_update: (a) => (typeof a.title === "string" ? `Update task \"${a.title}\"` : null), // id-only → server-side
  task_delete: () => null, // id-only — resolved server-side (task title)
  chat_respond: () => null, // id-only — resolved server-side (chat title)
  chat_create: (a) => {
    if (typeof a.message !== "string") return null;
    const firstLine = a.message.trim().split("\n")[0];
    if (!firstLine) return null;
    const short = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    return `Start a new chat: ${short}`;
  },
  chat_delete: () => null, // id-only — resolved server-side (chat title)
  read: (a) => (typeof a.path === "string" ? `Read ${a.path}` : null),
  write: (a) => (typeof a.path === "string" ? `Write ${a.path}` : null),
  edit: (a) => (typeof a.path === "string" ? `Edit ${a.path}` : null),
  bash: (a) => {
    if (typeof a.command !== "string") return null;
    const firstLine = a.command.trim().split("\n")[0];
    if (!firstLine) return null;
    const short = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
    return `Run: ${short}`;
  },
  codemode: (a) => {
    if (typeof a.code !== "string") return null;
    const firstLine = a.code.trim().split("\n")[0];
    if (!firstLine) return null;
    const short = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
    return `Run codemode script: ${short}`;
  },
  job_run: () => null, // id-only — resolved server-side (job name)
  job_enable: (a) => {
    if (typeof a.enabled !== "boolean") return null;
    return a.enabled ? "Enable a job" : "Disable a job"; // + job name server-side
  },
  job_update: () => null, // id-only — resolved server-side (job name)
  job_delete: () => null, // id-only — resolved server-side (job name)
  agent_job_create: (a) => (typeof a.name === "string" ? `Create agent job \"${a.name}\"` : null),
  agent_job_run: () => null, // id-only — resolved server-side (job name)
  agent_job_update: () => null, // id-only — resolved server-side (job name)
  agent_job_delete: () => null, // id-only — resolved server-side (job name)
};

/**
 * One-line headline for a concrete tool call, derived from its arguments.
 *
 * Prefers the catalog `summaryTemplate`, then the per-tool builder, else null
 * (id-only references are enriched server-side — see tool-approval-summary).
 * Client-safe: no database access.
 */
export function summarizeToolAction(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const info = findToolInfo(toolName);
  if (info?.summaryTemplate) return resolveTemplate(info.summaryTemplate, args);
  const builder = SUMMARY_BUILDERS[toolName];
  if (builder) return builder(args);
  return null;
}

/**
 * Describe a concrete tool call for the approval dialog:
 * friendly name, one-line summary, and labeled argument fields.
 *
 * Client-safe (no database access) — unknown tools (e.g. MCP) still get a
 * labeled breakdown with humanized keys.
 */
export function describeToolAction(toolName: string, args: Record<string, unknown>): ToolAction {
  const info = findToolInfo(toolName);
  const argLabels = TOOL_ARG_LABELS[toolName];

  const fields: ToolActionField[] = Object.entries(args).map(([key, value]) => ({
    key,
    label: argLabels?.[key] ?? humanizeKey(key),
    value,
  }));

  return {
    toolName,
    label: info?.label ?? toolName,
    description: info?.description ?? "",
    summary: summarizeToolAction(toolName, args),
    fields,
    known: info !== undefined,
  };
}
