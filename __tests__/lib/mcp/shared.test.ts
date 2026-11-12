import { describe, it, expect } from "vitest";
import { mergeOwnedRows } from "@/lib/shared-resources";
import {
  isMcpToolPolicy,
  isMcpTransport,
  MCP_COMMAND_MAX,
  MCP_ENV_MAX_VARS,
  MCP_ENV_VALUE_MAX_BYTES,
  MCP_TOOL_PREFIX,
  mcpEnvNames,
  mcpNameKey,
  mcpServerFromToolName,
  normalizeMcpServerName,
  parseMcpEnv,
  parseMcpEnvRemove,
  toMcpServerView,
  validateMcpCommand,
  validateMcpCwd,
  validateMcpServerName,
  validateMcpUrl,
} from "@/lib/mcp/shared";

describe("MCP server names", () => {
  it("accepts letters, digits, dashes and underscores", () => {
    expect(validateMcpServerName("homeassistant")).toBeNull();
    expect(validateMcpServerName("home-assistant")).toBeNull();
    expect(validateMcpServerName("ha_2")).toBeNull();
  });

  it("rejects characters Pi would rewrite into tool names", () => {
    expect(validateMcpServerName("my server")).not.toBeNull();
    expect(validateMcpServerName("hass.assistant")).not.toBeNull();
    expect(validateMcpServerName("")).not.toBeNull();
    expect(validateMcpServerName("a".repeat(65))).not.toBeNull();
  });

  it("treats dashes and underscores as the same name, like Pi does", () => {
    expect(mcpNameKey("Home-Assistant")).toBe("home_assistant");
    expect(mcpNameKey("home_assistant")).toBe("home_assistant");
  });
});

describe("normalizeMcpServerName", () => {
  it("folds a label the user typed into a name Pi accepts", () => {
    expect(normalizeMcpServerName("Local Figma")).toBe("local_figma");
    expect(normalizeMcpServerName("GitHub")).toBe("github");
    expect(normalizeMcpServerName("  Home Assistant 2  ")).toBe("home_assistant_2");
    for (const name of ["local_figma", "github", "home_assistant_2"]) {
      expect(validateMcpServerName(name)).toBeNull();
    }
  });

  it("collapses separator runs, which Pi would read as one character", () => {
    expect(normalizeMcpServerName("home__assistant")).toBe("home_assistant");
    expect(normalizeMcpServerName("home - assistant")).toBe("home_assistant");
    expect(normalizeMcpServerName("home_-_assistant")).toBe("home_assistant");
    expect(normalizeMcpServerName("--edge--")).toBe("edge");
  });

  it("cuts to the accepted length without leaving a trailing separator", () => {
    expect(normalizeMcpServerName("a".repeat(70))).toBe("a".repeat(64));

    const atTheEdge = `${"a".repeat(63)} b`;
    const cut = normalizeMcpServerName(atTheEdge);
    expect(cut).toBe("a".repeat(63));
    expect(validateMcpServerName(cut)).toBeNull();
  });

  it("folds to nothing when the input has no usable character", () => {
    expect(normalizeMcpServerName("")).toBe("");
    expect(normalizeMcpServerName("   ")).toBe("");
    expect(normalizeMcpServerName("!!!")).toBe("");
    expect(normalizeMcpServerName("---")).toBe("");
  });

  it("is idempotent, so an already-stored name round-trips unchanged", () => {
    for (const name of ["local_figma", "github", "home_assistant_2", "edge"]) {
      expect(normalizeMcpServerName(name)).toBe(name);
    }
  });
});

describe("MCP tool names", () => {
  it("extracts the server segment", () => {
    expect(mcpServerFromToolName("mcp__homeassistant__HassTurnOn")).toBe("homeassistant");
    expect(mcpServerFromToolName("mcp__home_assistant__HassTurnOn")).toBe("home_assistant");
    // Tool names may themselves contain double underscores.
    expect(mcpServerFromToolName("mcp__docs__read__page")).toBe("docs");
  });

  it("returns null for tools that are not MCP tools", () => {
    expect(mcpServerFromToolName("bash")).toBeNull();
    expect(mcpServerFromToolName("mcp__broken")).toBeNull();
    expect(mcpServerFromToolName("mcp____x")).toBeNull();
  });

  it("keys a tool's server the same way as the configured server name", () => {
    const server = mcpServerFromToolName("mcp__home_assistant__HassTurnOn");
    expect(server).not.toBeNull();
    expect(server).toBe(mcpNameKey("home-assistant"));
  });
});

describe("MCP URLs", () => {
  it("accepts http and https endpoints, including LAN hosts", () => {
    expect(validateMcpUrl("https://homeassistant.local:8123/api/mcp")).toBeNull();
    expect(validateMcpUrl("http://192.168.1.10:8123/api/mcp")).toBeNull();
  });

  it("rejects malformed URLs and other schemes", () => {
    expect(validateMcpUrl("not a url")).not.toBeNull();
    expect(validateMcpUrl("ftp://example.com/mcp")).not.toBeNull();
    expect(validateMcpUrl("file:///etc/passwd")).not.toBeNull();
    expect(validateMcpUrl("")).not.toBeNull();
  });
});

describe("MCP transports", () => {
  it("recognizes the two ways a server is reached", () => {
    expect(isMcpTransport("http")).toBe(true);
    expect(isMcpTransport("stdio")).toBe(true);
    expect(isMcpTransport("sse")).toBe(false);
    expect(isMcpTransport(undefined)).toBe(false);
  });
});

describe("a command server's command", () => {
  it("accepts a command line the shell can run", () => {
    expect(validateMcpCommand("npx -y @modelcontextprotocol/server-filesystem .")).toBeNull();
    expect(validateMcpCommand('node "my server.js" --flag')).toBeNull();
  });

  it("refuses an empty command and one past the length limit", () => {
    expect(validateMcpCommand("")).not.toBeNull();
    expect(validateMcpCommand("   ")).not.toBeNull();
    expect(validateMcpCommand("a".repeat(MCP_COMMAND_MAX + 1))).not.toBeNull();
  });

  it("refuses a NUL byte, which would truncate the command in a syscall", () => {
    expect(validateMcpCommand("node\0server.mjs")).not.toBeNull();
  });
});

describe("a command server's working directory", () => {
  it("accepts a path inside the workspace", () => {
    expect(validateMcpCwd("")).toBeNull();
    expect(validateMcpCwd("docs")).toBeNull();
    expect(validateMcpCwd("projects/site")).toBeNull();
    expect(validateMcpCwd("./docs")).toBeNull();
  });

  it("refuses an absolute path or a home directory", () => {
    expect(validateMcpCwd("/etc")).not.toBeNull();
    expect(validateMcpCwd("~/secrets")).not.toBeNull();
  });

  it("refuses a path that climbs out of the workspace", () => {
    expect(validateMcpCwd("../another-account")).not.toBeNull();
    expect(validateMcpCwd("docs/../..")).not.toBeNull();
  });
});

describe("a command server's variables", () => {
  it("keeps the names and values it was given", () => {
    expect(parseMcpEnv({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x", REGION: "eu" })).toEqual({
      ok: true,
      value: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x", REGION: "eu" },
    });
  });

  it("treats an absent set as none", () => {
    expect(parseMcpEnv(undefined)).toEqual({ ok: true, value: {} });
  });

  it("reads a variable that holds JSON, as Notion's headers do", () => {
    const headers = '{"Authorization":"Bearer ntn_x"}';
    expect(parseMcpEnv({ OPENAPI_MCP_HEADERS: headers })).toEqual({
      ok: true,
      value: { OPENAPI_MCP_HEADERS: headers },
    });
  });

  it("takes a number or a boolean as its text, as another client's config may hold", () => {
    expect(parseMcpEnv({ PORT: 8080, DEBUG: true })).toEqual({
      ok: true,
      value: { PORT: "8080", DEBUG: "true" },
    });
  });

  it("refuses a name a shell could not read", () => {
    const result = parseMcpEnv({ "not-a-name": "x" });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("Variable names");
  });

  it("refuses a value with a NUL byte", () => {
    expect(parseMcpEnv({ TOKEN: "a\0b" }).ok).toBe(false);
  });

  it("refuses a list where a set of names belongs", () => {
    expect(parseMcpEnv(["TOKEN"]).ok).toBe(false);
  });

  it("refuses more variables than a server may carry", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: MCP_ENV_MAX_VARS + 1 }, (_, index) => [`VAR_${index}`, "x"]),
    );
    const result = parseMcpEnv(tooMany);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(`${MCP_ENV_MAX_VARS}`);
  });

  it("refuses a value over the size a variable may hold", () => {
    expect(parseMcpEnv({ TOKEN: "x".repeat(MCP_ENV_VALUE_MAX_BYTES + 1) }).ok).toBe(false);
  });

  it("removes only the names it is given", () => {
    expect(parseMcpEnvRemove(["TOKEN", "REGION"])).toEqual({
      ok: true,
      value: ["TOKEN", "REGION"],
    });
    expect(parseMcpEnvRemove([])).toEqual({ ok: true, value: [] });
    expect(parseMcpEnvRemove(undefined)).toEqual({ ok: true, value: [] });
    expect(parseMcpEnvRemove("TOKEN").ok).toBe(false);
  });

  it("lists the names stored for the sheet, never a value", () => {
    const stored = JSON.stringify({ REGION: "ciphertext", TOKEN: "ciphertext" });
    expect(mcpEnvNames(stored)).toEqual(["REGION", "TOKEN"]);
    expect(mcpEnvNames(null)).toEqual([]);
    // A column that no longer parses lists nothing instead of failing the page.
    expect(mcpEnvNames("{not json")).toEqual([]);
  });
});

describe("MCP tool policies", () => {
  it("recognizes the three stored policies", () => {
    expect(isMcpToolPolicy("ask")).toBe(true);
    expect(isMcpToolPolicy("allow")).toBe(true);
    expect(isMcpToolPolicy("off")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isMcpToolPolicy("auto")).toBe(false);
    expect(isMcpToolPolicy("")).toBe(false);
    expect(isMcpToolPolicy(undefined)).toBe(false);
    expect(isMcpToolPolicy(1)).toBe(false);
  });
});

describe("toMcpServerView", () => {
  const row = {
    id: "srv-1",
    name: "homeassistant",
    transport: "http",
    url: "https://homeassistant.local:8123/api/mcp",
    command: null,
    cwd: null,
    description: "Control the smart home",
    encryptedToken: "iv:tag:ciphertext",
    toolPolicy: "allow",
    enabled: true,
    chatEnabled: true,
    coderEnabled: true,
    createdAt: new Date("2026-01-01T09:00:00Z"),
    updatedAt: new Date("2026-01-02T09:00:00Z"),
  };

  it("never exposes the encrypted token", () => {
    const view = toMcpServerView(row);
    expect(view.hasToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain("ciphertext");
  });

  it("reports the variables a command carries as names", () => {
    const view = toMcpServerView({
      ...row,
      transport: "stdio",
      url: null,
      command: "npx -y @modelcontextprotocol/server-github",
      env: JSON.stringify({ GITHUB_PERSONAL_ACCESS_TOKEN: "ciphertext" }),
    });
    expect(view.envNames).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    expect(JSON.stringify(view)).not.toContain("ciphertext");
  });

  it("reports no variables for a server that has none", () => {
    expect(toMcpServerView(row).envNames).toEqual([]);
  });

  it("reports a missing token and the stored policy", () => {
    const view = toMcpServerView({ ...row, encryptedToken: null, toolPolicy: "off" });
    expect(view.hasToken).toBe(false);
    expect(view.toolPolicy).toBe("off");
  });

  it("falls back to ask for a policy it does not understand", () => {
    expect(toMcpServerView({ ...row, toolPolicy: "yolo" }).toolPolicy).toBe("ask");
  });

  it("reports a command server with its command and working directory", () => {
    const view = toMcpServerView({
      ...row,
      transport: "stdio",
      url: null,
      command: "node mcp.mjs",
      cwd: "docs",
    });

    expect(view).toMatchObject({
      transport: "stdio",
      url: null,
      command: "node mcp.mjs",
      cwd: "docs",
    });
  });

  it("reads an unknown stored transport as an HTTP server", () => {
    expect(toMcpServerView({ ...row, transport: "carrier-pigeon" }).transport).toBe("http");
  });
});

describe("tool names of a merged server set", () => {
  /** A tool of one server, named the way Pi names it. */
  function toolName(server: string, tool: string): string {
    return `${MCP_TOOL_PREFIX}${server}__${tool}`;
  }

  it("leaves every merged server its own namespace", () => {
    // The instance lists a server the user already has under the other spelling.
    const merged = mergeOwnedRows({
      own: [{ name: "home-assistant" }],
      shared: [{ name: "home_assistant" }, { name: "docs" }],
      keyOf: (server) => mcpNameKey(server.name),
    });

    const namespaces = merged.map((server) => mcpNameKey(server.name));
    expect(new Set(namespaces).size).toBe(merged.length);
    expect(merged.map((server) => toolName(server.name, "search"))).toEqual([
      "mcp__home-assistant__search",
      "mcp__docs__search",
    ]);
  });

  it("maps a tool name back to the server that contributes it", () => {
    const merged = mergeOwnedRows({
      own: [],
      shared: [{ name: "docs" }, { name: "home-assistant" }],
    });

    for (const server of merged) {
      expect(mcpServerFromToolName(toolName(server.name, "search"))).toBe(server.name);
    }
  });
});
