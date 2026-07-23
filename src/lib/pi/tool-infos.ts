/**
 * Static catalog of all available tool names and descriptions.
 * Used by the settings UI to render per-tool policy selectors.
 * Client-safe — no server-only imports.
 */
export interface ToolInfo {
  name: string;
  label: string;
  description: string;
}

export const ALL_TOOL_INFOS: ToolInfo[] = [
  // Terminal tools (Pi built-ins)
  { name: "read", label: "Read", description: "Read file contents" },
  { name: "write", label: "Write", description: "Write content to a file" },
  { name: "edit", label: "Edit", description: "Edit a file with targeted replacements" },
  { name: "bash", label: "Bash", description: "Execute shell commands" },

  // Chat tools
  { name: "show_file", label: "Show File", description: "Show a file as an attachment" },

  // Email tools
  { name: "mail_send", label: "Send Email", description: "Send an email" },
  { name: "mail_search", label: "Search Email", description: "Search email inbox" },
  { name: "mail_read", label: "Read Email", description: "Read an email by ID" },
  { name: "mail_draft", label: "Draft Email", description: "Draft an email for review" },

  // Job tools
  { name: "job_list", label: "List Jobs", description: "List job listings" },
  { name: "job_apply", label: "Apply to Job", description: "Apply to a job listing" },

  // Calendar tools
  { name: "calendar_list", label: "List Events", description: "List calendar events" },
  { name: "calendar_create", label: "Create Event", description: "Create a calendar event" },
  { name: "calendar_update", label: "Update Event", description: "Update a calendar event" },
  { name: "calendar_delete", label: "Delete Event", description: "Delete a calendar event" },

  // Web tools
  { name: "web_search", label: "Web Search", description: "Search the web" },
  { name: "web_fetch", label: "Web Fetch", description: "Fetch a web page" },

  // Memory tools
  { name: "memory_save", label: "Save Memory", description: "Save information to memory" },
  { name: "memory_search", label: "Search Memory", description: "Search saved memories" },
  { name: "memory_delete", label: "Delete Memory", description: "Delete a memory" },

  // Task tools
  { name: "task_create", label: "Create Task", description: "Create a new task" },
  { name: "task_update", label: "Update Task", description: "Update a task" },
  { name: "task_delete", label: "Delete Task", description: "Delete a task" },
  { name: "task_list", label: "List Tasks", description: "List tasks" },

  // Agent job tools
  {
    name: "agent_job_create",
    label: "Create Agent Job",
    description: "Create a background agent job",
  },
  { name: "agent_job_list", label: "List Agent Jobs", description: "List agent jobs" },
  { name: "agent_job_cancel", label: "Cancel Agent Job", description: "Cancel an agent job" },

  // Infra tools
  { name: "infra_status", label: "Infra Status", description: "Check infrastructure status" },
];
