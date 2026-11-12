/**
 * The configs people paste, as the clients write them.
 *
 * The shapes come from Claude Desktop, Cursor, VS Code and the servers' own
 * setup instructions: `mcpServers` around named entries, `command` with `args`,
 * `env`, `cwd`, or `url` with `headers`.
 */

import { describe, expect, it } from "vitest";
import { parseMcpConfig, quoteShellArg } from "@/lib/mcp/import-config";

function one(text: string) {
  const parsed = parseMcpConfig(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("parseMcpConfig", () => {
  it("reads a command server with its args and variables", () => {
    const result = one(
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
          },
        },
      }),
    );

    expect(result.skipped).toEqual([]);
    expect(result.servers).toEqual([
      {
        name: "github",
        transport: "stdio",
        url: null,
        command: "npx -y @modelcontextprotocol/server-github",
        cwd: null,
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
        token: null,
        description: "",
      },
    ]);
  });

  it("keeps an argument with spaces or a dollar sign as one argument", () => {
    const result = one(
      JSON.stringify({
        mcpServers: {
          files: {
            command: "npx",
            args: ["-y", "server", "/home/docs with space", "$HOME/x"],
          },
        },
      }),
    );

    expect(result.servers[0]!.command).toBe("npx -y server '/home/docs with space' '$HOME/x'");
  });

  it("reads VS Code's `servers` and a bare list", () => {
    const named = one(JSON.stringify({ servers: { docs: { url: "https://example.com/mcp" } } }));
    expect(named.servers[0]).toMatchObject({
      name: "docs",
      transport: "http",
      url: "https://example.com/mcp",
    });

    const listed = one(JSON.stringify([{ name: "memory", command: "npx -y server-memory" }]));
    expect(listed.servers[0]).toMatchObject({ name: "memory", transport: "stdio" });
  });

  it("takes a bearer token out of an endpoint's headers", () => {
    const result = one(
      JSON.stringify({
        mcpServers: {
          home: {
            url: "https://home.local/mcp",
            headers: { Authorization: "Bearer abc123" },
          },
        },
      }),
    );

    expect(result.servers[0]).toMatchObject({ transport: "http", token: "abc123" });
  });

  it("folds a name into the shape a tool name needs", () => {
    const result = one(
      JSON.stringify({ mcpServers: { "Google Drive": { url: "https://x/mcp" } } }),
    );
    expect(result.servers[0]!.name).toBe("google_drive");
  });

  it("reports an entry with neither a command nor a URL, and keeps the rest", () => {
    const result = one(
      JSON.stringify({
        mcpServers: {
          broken: { type: "stdio" },
          memory: { command: "npx -y @modelcontextprotocol/server-memory" },
        },
      }),
    );

    expect(result.servers.map((server) => server.name)).toEqual(["memory"]);
    expect(result.skipped).toEqual([
      { name: "broken", error: "This entry has neither a command nor a URL." },
    ]);
  });

  it("refuses an SSE endpoint, which this client cannot speak", () => {
    const result = one(
      JSON.stringify({ mcpServers: { old: { type: "sse", url: "https://x/sse" } } }),
    );
    expect(result.skipped[0]!.error).toContain("SSE");
  });

  it("refuses the same name twice", () => {
    const result = one(
      JSON.stringify([
        { name: "memory", command: "npx -y one" },
        { name: "memory", command: "npx -y two" },
      ]),
    );
    expect(result.servers).toHaveLength(1);
    expect(result.skipped[0]!.error).toContain("same name");
  });

  it("says what is wrong when the text is not a config", () => {
    expect(parseMcpConfig("").ok).toBe(false);
    expect(parseMcpConfig("{not json").ok).toBe(false);
    expect(parseMcpConfig('"just a string"').ok).toBe(false);
    expect(parseMcpConfig(JSON.stringify({ mcpServers: {} })).ok).toBe(false);
  });

  it("refuses a config too large to have been pasted by hand", () => {
    const big = JSON.stringify({
      mcpServers: { x: { command: "npx", env: { A: "x".repeat(70_000) } } },
    });
    const parsed = parseMcpConfig(big);
    expect(parsed.ok).toBe(false);
  });
});

describe("quoteShellArg", () => {
  it("leaves a plain argument alone", () => {
    expect(quoteShellArg("@modelcontextprotocol/server-github")).toBe(
      "@modelcontextprotocol/server-github",
    );
    expect(quoteShellArg("--transport=stdio")).toBe("--transport=stdio");
  });

  it("quotes what the shell would otherwise split or expand", () => {
    expect(quoteShellArg("a b")).toBe("'a b'");
    expect(quoteShellArg("$HOME")).toBe("'$HOME'");
    expect(quoteShellArg("it's")).toBe(`'it'\\''s'`);
  });
});
