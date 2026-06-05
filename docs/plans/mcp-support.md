# MCP Support — Plan

Connect external MCP servers so the AI agent can use their tools during chat sessions.
The user configures servers in settings; tools are resolved at session creation time
and injected as custom tools alongside email, calendar, web, etc.

---

## Problem

- Saale's AI agent is limited to its built-in tool categories (email, calendar, web,
  memory, jobs, files, bash).
- The MCP ecosystem has hundreds of useful servers (GitHub, Figma, databases,
  filesystems, browsers, APIs) that users want access to.
- Pi's philosophy is "extend it yourself" — no native MCP support will land in the SDK.

## Goals

- **User-configurable.** The user adds MCP servers via a settings UI — no code changes
  needed to add new servers.
- **Transparent to the agent.** MCP tools appear alongside built-in tools. The agent
  calls them the same way it calls `web_search` or `email_read`.
- **Scoped to the user.** MCP servers are per-user (like email/calendar accounts).
  No data leakage between users.
- **Graceful failures.** A broken MCP server doesn't crash the chat session. Tools
  from failed servers are simply omitted.
- **No persistent connections.** MCP servers connect per-session (session creation →
  tool resolution → session end → disconnect). Simpler than keep-alive, fits the
  request-response model of a web app.

## Non-Goals

- MCP resources or prompts (tools only for now).
- MCP sampling or elicitation (Pi SDK doesn't expose the hooks needed).
- Proxy-style tool discovery (like `pi-mcp-adapter`'s single proxy tool).
  Saale's embedded agent doesn't have the same context window constraints as the
  Pi CLI — direct tool registration is simpler and more reliable.
- OAuth flows for MCP servers (out of scope for v1; bearer tokens and unauth
  servers cover the common cases).

---

## Architecture

```
User Settings UI
    │  (add/edit/delete MCP server configs)
    ▼
┌──────────────────┐
│ McpServer (DB)   │  Prisma model — one row per user-server pair
│ (PostgreSQL)     │
└────────┬─────────┘
         │ fetched at session creation
         ▼
┌──────────────────┐
│ McpClientManager │  connects → listTools → convert schemas → disconnect
│ (transient)      │
└────────┬─────────┘
         │ produces ToolDefinition[]
         ▼
┌──────────────────┐
│ createPiSession  │  MCP tools merged into customTools array
│ (existing)       │  alongside email, calendar, web, memory, etc.
└────────┬─────────┘
         │
         ▼
    AI Agent Session
    (calls MCP tools like any other tool)
```

### Flow

1. User adds an MCP server in settings (name, command/URL, env vars, enabled toggle).
2. Config is stored in the `McpServer` Prisma model (user-scoped).
3. When a chat session is created (`createPiSession`), enabled MCP servers are
   fetched from the DB.
4. For each enabled server, `McpClientManager` connects, lists tools, converts
   schemas to Pi `ToolDefinition[]`, and disconnects.
5. MCP tool definitions are merged into the `customTools` array passed to
   `createAgentSession`.
6. During the session, the agent calls MCP tools like any other tool.
   Each call triggers a new connect → call → disconnect cycle
   (or uses a short-lived connection pool if the same server has multiple tools
   called in one turn).
7. When the session ends, any remaining connections are closed.

---

## Data Model

### New Model

```prisma
model McpServer {
  id          String   @id @default(cuid())
  userId      String
  name        String   // User-friendly label (e.g. "GitHub", "Local Figma")
  description String?  @db.Text // Optional — what this server provides

  // Transport — either stdio (command) or HTTP (url), not both
  transport   String   @default("stdio") // "stdio" | "http"
  command     String?  // Executable (e.g. "npx", "uvx", "/path/to/binary")
  args        String?  @db.Text // JSON array of strings (e.g. ["-y", "@modelcontextprotocol/server-github"])
  env         String?  @db.Text // JSON object of env vars (e.g. { "GITHUB_TOKEN": "ghp_..." })
  cwd         String?  // Working directory for stdio transport
  url         String?  // HTTP endpoint for streamable-http transport
  headers     String?  @db.Text // JSON object of HTTP headers

  enabled     Boolean  @default(true)
  lastError   String?  @db.Text // Last connection error (cleared on success)
  lastCheckedAt DateTime? // When we last successfully listed tools

  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([userId, enabled])
  @@map("McpServer")
}
```

### Why JSON fields for args/env/headers

These are structured data that don't benefit from relational storage.
Storing as JSON text avoids a sprawling schema and matches how MCP configs
are typically written (`.mcp.json` files use the same format).

`env` values are stored as-is — if the user wants to store secrets, they
should use environment variable references in the value (e.g., `"$GITHUB_TOKEN"`)
which we resolve at runtime. This keeps sensitive values out of the DB.

---

## Implementation

### 1. MCP Client Manager (`src/lib/mcp/client.ts`)

Core client that handles MCP connections and tool resolution.

```ts
// src/lib/mcp/client.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHttp } from "@modelcontextprotocol/sdk/client/http.js";
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { type McpServer } from "@prisma/client";

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: unknown }>;
  isError?: boolean;
}

export class McpClientManager {
  /**
   * Connect to an MCP server and resolve its tools into Pi ToolDefinitions.
   * Handles both stdio and HTTP transports.
   * Connections are short-lived — connect, list tools, return definitions
   * that carry a closure for execution.
   */
  static async resolveTools(
    servers: McpServer[],
  ): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];

    for (const server of servers) {
      const serverTools = await this.resolveServerTools(server);
      tools.push(...serverTools);
    }

    return tools;
  }

  private static async resolveServerTools(
    server: McpServer,
  ): Promise<ToolDefinition[]> {
    const transport = this.createTransport(server);
    const client = new Client(
      { name: "saale", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const { tools: mcpTools } = await client.listTools();

      return mcpTools.map((mcpTool) =>
        this.createToolDefinition(server, mcpTool, client, transport),
      );
    } finally {
      await client.close();
    }
  }

  private static createTransport(server: McpServer) {
    if (server.transport === "http" && server.url) {
      return new StreamableHttp(new URL(server.url), {
        requestInit: {
          headers: server.headers ? JSON.parse(server.headers) : undefined,
        },
      });
    }

    return new StdioClientTransport({
      command: server.command!,
      args: server.args ? JSON.parse(server.args) : [],
      env: server.env
        ? this.resolveEnvVars(JSON.parse(server.env))
        : undefined,
      cwd: server.cwd,
    });
  }

  /**
   * Create a Pi ToolDefinition from an MCP tool.
   * The execute function reconnects to the server on each call.
   */
  private static createToolDefinition(
    server: McpServer,
    mcpTool: McpToolInfo,
  ): ToolDefinition {
    return defineTool({
      name: `mcp_${server.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${mcpTool.name}`,
      label: `${server.name}: ${mcpTool.name}`,
      description: mcpTool.description || `MCP tool from ${server.name}`,
      parameters: jsonSchemaToTypeBox(mcpTool.inputSchema),
      execute: async (_toolCallId, params) => {
        // Reconnect for each tool call
        const transport = this.createTransport(server);
        const client = new Client(
          { name: "saale", version: "0.1.0" },
          { capabilities: {} },
        );

        try {
          await client.connect(transport);
          const result = await client.callTool({ name: mcpTool.name, arguments: params });
          return this.formatMcpResult(result);
        } finally {
          await client.close();
        }
      },
    });
  }

  private static formatMcpResult(result: McpToolResult) {
    const textBlocks = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return {
      content: [{ type: "text", text: textBlocks || "(no output)" }],
      isError: result.isError || false,
    };
  }

  private static resolveEnvVars(env: Record<string, string>): NodeJS.ProcessEnv {
    const resolved: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
      // Resolve $VAR and ${VAR} references from process.env
      resolved[key] = value.replace(
        /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
        (_, envVar) => process.env[envVar] ?? "",
      );
    }
    return resolved;
  }
}
```

### 2. Schema Conversion (`src/lib/mcp/schema-converter.ts`)

Convert MCP JSON Schema to TypeBox schemas for Pi's `defineTool`.

MCP tools declare their input as JSON Schema (`inputSchema`). Pi tools use
TypeBox (`Type.Object({...})`). We need a converter.

```ts
// src/lib/mcp/schema-converter.ts

import { Type, type TSchema } from "typebox";

/**
 * Convert a JSON Schema object to a TypeBox schema.
 * Handles: object, string, number, integer, boolean, array, enum.
 * Nested objects are supported. Optional properties (not in required[]) get Type.Optional().
 */
export function jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
  if (!schema || typeof schema !== "object") {
    return Type.Object({});
  }

  const type = (schema.type as string) ?? "object";

  if (type === "object") {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = (schema.required as string[]) ?? [];

    if (!properties || Object.keys(properties).length === 0) {
      return Type.Object({});
    }

    const typeboxProps: Record<string, TSchema> = {};

    for (const [key, propSchema] of Object.entries(properties)) {
      const converted = convertProperty(propSchema);
      const isOptional = !required.includes(key);
      typeboxProps[key] = isOptional ? Type.Optional(converted) : converted;
    }

    return Type.Object(typeboxProps);
  }

  return convertProperty(schema);
}

function convertProperty(schema: Record<string, unknown>): TSchema {
  const type = schema.type as string | undefined;
  const description = schema.description as string | undefined;
  const opts: Record<string, unknown> = {};
  if (description) opts.description = description;

  // Handle enums
  if (schema.enum) {
    const values = schema.enum as unknown[];
    return Type.Union(values.map((v) => Type.Literal(v)), opts);
  }

  switch (type) {
    case "string":
      return Type.String(opts);
    case "number":
      return Type.Number(opts);
    case "integer":
      return Type.Integer(opts);
    case "boolean":
      return Type.Boolean(opts);
    case "array": {
      const items = schema.items as Record<string, unknown> | undefined;
      const itemSchema = items ? convertProperty(items) : Type.Unknown();
      return Type.Array(itemSchema, opts);
    }
    case "object": {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = (schema.required as string[]) ?? [];

      if (!properties) return Type.Object({}, opts);

      const typeboxProps: Record<string, TSchema> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        const converted = convertProperty(propSchema);
        const isOptional = !required.includes(key);
        typeboxProps[key] = isOptional ? Type.Optional(converted) : converted;
      }
      return Type.Object(typeboxProps, opts);
    }
    case "null":
      return Type.Null();
    default:
      return Type.Unknown(opts);
  }
}
```

**Known limitations:**
- Does not handle `$ref` references (most MCP tools inline their schemas)
- Does not handle `oneOf`/`anyOf` (falls back to `Type.Unknown()`)
- Does not handle string patterns, min/max lengths, etc.

These can be added later if real-world MCP servers need them.

### 3. Integration into Session Creation (`src/lib/pi/session.ts`)

Modify `createPiSession` to accept and resolve MCP tools.

```diff
  export async function createPiSession(options: {
    userId: string;
    customTools: ToolDefinition[];
    toolConfig?: ToolConfig;
+   mcpServers?: McpServer[];
    modelProvider?: string;
    modelName?: string;
    thinkingLevel?: string;
  }): Promise<CreateAgentSessionResult> {
```

After resolving built-in tools, resolve MCP tools:

```ts
// Resolve MCP tools (if any servers are enabled)
let mcpTools: ToolDefinition[] = [];
if (options.mcpServers && options.mcpServers.length > 0) {
  mcpTools = await McpClientManager.resolveTools(options.mcpServers);
}
allCustomTools.push(...mcpTools);
```

Errors during MCP resolution are caught per-server and logged — a broken
server doesn't prevent the session from starting.

### 4. API Route Changes (`src/app/api/chat/sessions/[sessionId]/stream/route.ts`)

Fetch user's enabled MCP servers and pass them to `createPiSession`.

```diff
  // Create Pi session with custom tools
  const { session: piSession } = await createPiSession({
    userId: authResult.user.id,
    customTools: [],
    ...(chatSession.toolConfig && { toolConfig: resolvedToolConfig }),
+   mcpServers: await prisma.mcpServer.findMany({
+     where: { userId: authResult.user.id, enabled: true },
+   }),
    ...(chatSession.modelProvider && { modelProvider: chatSession.modelProvider }),
    ...(chatSession.modelName && { modelName: chatSession.modelName }),
    thinkingLevel: chatSession.thinkingLevel || "off",
  });
```

### 5. Settings API (`src/app/api/mcp-servers/`)

CRUD endpoints for MCP server configuration.

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/api/mcp-servers` | List user's MCP servers |
| `POST` | `/api/mcp-servers` | Create a new MCP server |
| `GET` | `/api/mcp-servers/[id]` | Get server details (includes tool list) |
| `PATCH` | `/api/mcp-servers/[id]` | Update server config |
| `DELETE` | `/api/mcp-servers/[id]` | Delete server |
| `POST` | `/api/mcp-servers/[id]/test` | Test connection and return tool list |

The `test` endpoint connects to the server, lists tools, and disconnects —
used by the UI to validate config before saving.

All routes are scoped to `userId` via `requireSession()`.

### 6. Settings UI (`src/components/settings/mcp-servers/`)

- **Server list** — table of configured servers with name, transport, enabled
  toggle, and last error status.
- **Add server dialog** — form with fields for name, transport type, command/URL,
  args, env vars, and a "Test connection" button.
- **Edit server dialog** — same form pre-filled.
- **Tool preview** — after a successful test, show the list of available tools
  from that server.

Follows the same pattern as email/calendar account settings (sheet-based forms,
inline validation).

---

## Tool Naming

MCP tools are prefixed to avoid collisions with built-in tools:

```
mcp_{server_key}_{tool_name}
```

Where `server_key` is the server name lowercased, trimmed to `[a-z0-9_]`,
truncated to 20 chars. Examples:

| Server name | Tool name | Resolved name |
|-------------|-----------|---------------|
| `GitHub` | `search_repositories` | `mcp_github_search_repositories` |
| `Local Figma` | `get_file_contents` | `mcp_local_figma_get_file_contents` |
| `postgres-mcp` | `read_rows` | `mcp_postgres_mcp_read_rows` |

If two servers produce the same resolved name, append a numeric suffix.

---

## Error Handling

### Connection Failures

- During session creation: the server is skipped, error logged.
  `lastError` is updated in the DB. Other servers proceed normally.
- During tool execution: the error is returned to the agent as an `isError: true`
  tool result. The agent can retry or continue without that tool's output.

### Timeout

- Each MCP connection has a 10-second timeout (configurable via env var
  `MCP_CONNECT_TIMEOUT_MS`).
- Each tool call has a 60-second timeout (configurable via
  `MCP_TOOL_CALL_TIMEOUT_MS`).
- Timeouts return a clear error message to the agent.

### Sandbox Considerations

For stdio transport, the `command` is executed on the host machine (not in
the open-terminal container). This means:

- `npx`-based servers require npm to be installed on the host.
- Arbitrary commands are a security risk — the `command` field should be
  validated against an allowlist for self-hosted instances.
- For Docker deployments, MCP servers should use HTTP transport instead.

An env var `MCP_ALLOW_STDIO` (default: `true`) can disable stdio transport
entirely on restricted deployments.

---

## Migration Plan

### Phase 1: Core (this plan)

1. Add `McpServer` Prisma model + migration
2. Implement `McpClientManager` + schema converter
3. Integrate into `createPiSession`
4. Build Settings API (`/api/mcp-servers/*`)
5. Build Settings UI (add/edit/test/delete servers)
6. Add error handling, timeouts, env var resolution

### Phase 2: Polish

- Tool usage analytics (which MCP tools are called most)
- Server health indicator in chat header (green/yellow/red dot)
- Per-server enable/disable in chat session tool config
- Connection pooling for servers with multiple tools called in one turn

### Phase 3: Advanced

- OAuth support for MCP servers (build on top of Pi's auth storage pattern)
- MCP resources exposed as read-only tools
- Preset server templates (GitHub, Figma, PostgreSQL, etc.) in the add dialog

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| MCP server crashes hang the session | Timeouts on connect and tool calls. Per-server error isolation. |
| stdio commands are a security risk | `MCP_ALLOW_STDIO` env var. Allowlist validation for self-hosted. |
| Tool name collisions with built-in tools | `mcp_` prefix on all MCP tool names. |
| Large tool sets bloat the context window | Users control which servers are enabled. No server auto-enables. |
| Schema conversion misses edge cases | Falls back to `Type.Unknown()` for unsupported types. MCP server still validates args. |
