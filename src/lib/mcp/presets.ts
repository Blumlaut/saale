/**
 * The servers people install first, ready to fill in.
 *
 * A preset is the command line and the variables a server needs, nothing else:
 * choosing it fills the sheet's fields and leaves the value of each variable to
 * the person who has the key. Commands are copied from the projects' own setup
 * instructions, so a preset that stops working is a bug in this file.
 */

export interface McpPresetVariable {
  name: string;
  /** What the value is, shown under the field that waits for it. */
  what: string;
}

export interface McpPreset {
  id: string;
  label: string;
  /** The line the model reads about the server. */
  description: string;
  name: string;
  /** `http` for a remote endpoint, `stdio` for a command in the workspace. */
  transport: "http" | "stdio";
  /** The endpoint of an HTTP preset. */
  url?: string;
  /** The command line of a stdio preset. */
  command?: string;
  /** Workspace-relative directory the command starts in. */
  cwd?: string;
  variables?: McpPresetVariable[];
  /** A sentence the sheet shows after the preset is chosen. */
  note?: string;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "filesystem",
    label: "Filesystem",
    description: "Read and write files in the workspace",
    name: "filesystem",
    transport: "stdio",
    command: "npx -y @modelcontextprotocol/server-filesystem .",
    note: "The dot is the directory the command may touch: your workspace root.",
  },
  {
    id: "memory",
    label: "Memory",
    description: "A knowledge graph that remembers between chats",
    name: "memory",
    transport: "stdio",
    command: "npx -y @modelcontextprotocol/server-memory",
    variables: [{ name: "MEMORY_FILE_PATH", what: "Optional file to keep the graph in" }],
  },
  {
    id: "git",
    label: "Git",
    description: "Read, search and commit in a repository",
    name: "git",
    transport: "stdio",
    command: "uvx mcp-server-git --repository .",
    note: "The dot is the repository: your workspace root.",
  },
  {
    id: "time",
    label: "Time",
    description: "Time and timezone conversion",
    name: "time",
    transport: "stdio",
    command: "uvx mcp-server-time",
  },
  {
    id: "fetch",
    label: "Fetch",
    description: "Fetch a web page and turn it into text the model can read",
    name: "fetch",
    transport: "stdio",
    command: "uvx mcp-server-fetch",
  },
  {
    id: "sequential-thinking",
    label: "Sequential thinking",
    description: "Work a problem through step by step",
    name: "sequential_thinking",
    transport: "stdio",
    command: "npx -y @modelcontextprotocol/server-sequential-thinking",
  },
  {
    id: "github",
    label: "GitHub",
    description: "Issues, pull requests and code search on GitHub",
    name: "github",
    transport: "stdio",
    command: "npx -y @modelcontextprotocol/server-github",
    variables: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", what: "A token with repo scope" }],
    note: "GitHub also hosts an endpoint at https://api.githubcopilot.com/mcp/, which signs in.",
  },
  {
    id: "brave-search",
    label: "Brave Search",
    description: "Web, news and local search through the Brave API",
    name: "brave_search",
    transport: "stdio",
    command: "npx -y @brave/brave-search-mcp-server",
    variables: [{ name: "BRAVE_API_KEY", what: "A Brave Search API key" }],
  },
  {
    id: "context7",
    label: "Context7",
    description: "Up-to-date library documentation for the code being written",
    name: "context7",
    transport: "stdio",
    command: "npx -y @upstash/context7-mcp",
    variables: [{ name: "CONTEXT7_API_KEY", what: "A Context7 API key" }],
  },
  {
    id: "notion",
    label: "Notion",
    description: "Search and edit pages in a Notion workspace",
    name: "notion",
    transport: "stdio",
    command: "npx -y @notionhq/notion-mcp-server --transport stdio",
    variables: [{ name: "NOTION_TOKEN", what: "An internal integration token" }],
  },
  {
    id: "slack",
    label: "Slack",
    description: "Read channels and post messages in a Slack workspace",
    name: "slack",
    transport: "stdio",
    command: "npx -y @zencoderai/slack-mcp-server --transport stdio",
    variables: [{ name: "SLACK_BOT_TOKEN", what: "A bot token, xoxb-…" }],
  },
  {
    id: "playwright",
    label: "Playwright",
    description: "Drive a browser: open pages, click, fill in, screenshot",
    name: "playwright",
    transport: "stdio",
    command: "npx -y @playwright/mcp@latest --headless",
    note: "The workspace image points it at its own chromium, and there is no display, so keep --headless.",
  },
  {
    id: "linear",
    label: "Linear",
    description: "Issues and projects in a Linear workspace",
    name: "linear",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
  },
  {
    id: "sentry",
    label: "Sentry",
    description: "Errors and traces from Sentry",
    name: "sentry",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
  },
];

/** One preset by id, or undefined for an id no preset carries. */
export function findMcpPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}
