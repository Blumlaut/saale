/**
 * Static catalog of all available tool names and descriptions.
 * Used by the settings UI to render per-tool policy selectors.
 * Client-safe — no server-only imports.
 *
 * MUST stay in sync with the actual tool definitions in src/lib/pi/tools/.
 */
import type { ToolCategoryKey } from "@/lib/pi/tool-categories";

export type ToolPolicy = "allow" | "auto" | "ask" | "off";

/**
 * The "auto" policy is command-aware:
 * - For infra_exec: auto-approves safe commands (ls, cat, grep…), requires approval for risky ones (rm, echo >>, sudo…)
 * - For all other tools: behaves like "allow"
 */

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  /** Which tool category this tool belongs to. */
  category: ToolCategoryKey;
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
    name: "mail_draft",
    label: "Draft Email",
    description: "Draft an email for review",
    category: "email",
    defaultPolicy: "allow",
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
    description: "Save information to persistent memory",
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
    description: "Delete a memory",
    category: "memory",
    defaultPolicy: "allow",
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
];

/** Group tools by category key. */
export function getToolsByCategory(categoryKey: string): typeof ALL_TOOL_INFOS {
  return ALL_TOOL_INFOS.filter((t) => t.category === categoryKey);
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
