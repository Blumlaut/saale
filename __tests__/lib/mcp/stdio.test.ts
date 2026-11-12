/**
 * A stdio MCP server, all the way through the sandbox service.
 *
 * The command, its working directory and its output go through the same
 * `sandbox-exec` path a chat's MCP server uses; a checkout without the service
 * runs commands on this host, which is what these tests exercise. What they
 * cannot see is the container itself, so they assert the wiring the container
 * would carry: the command starts, JSON-RPC travels both ways, the working
 * directory is the one asked for, and a command that dies reports why.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFakeStdioMcpServer } from "../../helpers/fake-stdio-mcp-server";

const mockEnvFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    sandboxEnvVar: { findMany: (...args: unknown[]) => mockEnvFindMany(...args) },
  },
}));

import { McpClient } from "@earendil-works/pi-mcp";
import { _resetKey, encrypt } from "@/lib/crypto";
import { FilePathEscapeError } from "@/lib/files/errors";
import {
  createWorkspaceMcpTransport,
  probeStdioMcpServer,
  stopWorkspaceCommands,
  workspaceCommandCwd,
} from "@/lib/mcp/stdio";
import { userWorkspacePath } from "@/lib/sandbox/workspace";

const USER_ID = "user-stdio-1";
const TIMEOUT_MS = 60_000;
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let workspaces: string;
let workspace: string;
let previousDir: string | undefined;
let previousUrl: string | undefined;
let previousKey: string | undefined;

/** A place to put a workspace, and a service that is not there to run commands. */
beforeEach(async () => {
  workspaces = await mkdtemp(path.join(tmpdir(), "saale-stdio-"));
  previousDir = process.env.SANDBOX_WORKSPACES_DIR;
  previousUrl = process.env.SANDBOX_URL;
  previousKey = process.env.ENCRYPTION_KEY;
  process.env.SANDBOX_WORKSPACES_DIR = workspaces;
  process.env.ENCRYPTION_KEY = KEY;
  _resetKey();
  delete process.env.SANDBOX_URL;
  mockEnvFindMany.mockResolvedValue([]);

  workspace = userWorkspacePath(USER_ID);
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousDir === undefined) delete process.env.SANDBOX_WORKSPACES_DIR;
  else process.env.SANDBOX_WORKSPACES_DIR = previousDir;
  if (previousUrl === undefined) delete process.env.SANDBOX_URL;
  else process.env.SANDBOX_URL = previousUrl;
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousKey;
  _resetKey();
  await rm(workspaces, { recursive: true, force: true });
});

describe("probeStdioMcpServer", () => {
  it(
    "runs the command and reports the tools it offers",
    async () => {
      const command = await writeFakeStdioMcpServer(workspace, {
        name: "filesystem",
        tools: [
          { name: "read_file", description: "Read a file" },
          { name: "list_directory", description: "List a directory" },
        ],
      });

      const result = await probeStdioMcpServer(
        { userId: USER_ID, name: "files", command, cwd: null },
        { timeoutMs: TIMEOUT_MS },
      );

      expect(result.serverName).toBe("filesystem");
      expect(result.serverVersion).toBe("1.0.0");
      expect(result.tools).toEqual([
        { name: "read_file", description: "Read a file" },
        { name: "list_directory", description: "List a directory" },
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "starts the command in the working directory it was given",
    async () => {
      const docs = path.join(workspace, "docs");
      await mkdir(docs, { recursive: true });
      const command = await writeFakeStdioMcpServer(docs);

      const result = await probeStdioMcpServer(
        { userId: USER_ID, name: "docs", command, cwd: "docs" },
        { timeoutMs: TIMEOUT_MS },
      );

      // The fake reports its own working directory as its instructions.
      expect(result.instructions).toBe(docs);
    },
    TIMEOUT_MS,
  );

  it(
    "reports what a command that dies said on stderr",
    async () => {
      const command = await writeFakeStdioMcpServer(workspace, {
        failWith: "Error: Cannot find module '@modelcontextprotocol/server-nope'",
      });

      const failure = await probeStdioMcpServer(
        { userId: USER_ID, name: "broken", command, cwd: null },
        { timeoutMs: TIMEOUT_MS },
      ).catch((err: Error) => err);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('"broken"');
      expect((failure as Error).message).toContain(
        "Cannot find module '@modelcontextprotocol/server-nope'",
      );
    },
    TIMEOUT_MS,
  );

  it(
    "passes the account's own variables to the command",
    async () => {
      mockEnvFindMany.mockResolvedValue([
        { name: "FAKE_NAME", encryptedValue: encrypt("from-the-account-env") },
      ]);
      const command = await writeFakeStdioMcpServer(workspace, { envName: "FAKE_NAME" });

      const result = await probeStdioMcpServer(
        { userId: USER_ID, name: "env", command, cwd: null },
        { timeoutMs: TIMEOUT_MS },
      );

      // The fake reports the variable as its name, so the value arrived.
      expect(result.serverName).toBe("from-the-account-env");
      expect(mockEnvFindMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        select: { name: true, encryptedValue: true },
      });
    },
    TIMEOUT_MS,
  );
});

describe("a server's own variables", () => {
  it(
    "are passed to the command, over the account's",
    async () => {
      mockEnvFindMany.mockResolvedValue([
        { name: "FAKE_NAME", encryptedValue: encrypt("from-the-account-env") },
      ]);
      const command = await writeFakeStdioMcpServer(workspace, { envName: "FAKE_NAME" });

      const result = await probeStdioMcpServer(
        {
          userId: USER_ID,
          name: "env",
          command,
          cwd: null,
          env: { FAKE_NAME: "from-the-server-env" },
        },
        { timeoutMs: TIMEOUT_MS },
      );

      expect(result.serverName).toBe("from-the-server-env");
    },
    TIMEOUT_MS,
  );

  it(
    "leave the account's variables in place",
    async () => {
      mockEnvFindMany.mockResolvedValue([
        { name: "FAKE_NAME", encryptedValue: encrypt("from-the-account-env") },
      ]);
      const command = await writeFakeStdioMcpServer(workspace, { envName: "FAKE_NAME" });

      const result = await probeStdioMcpServer(
        {
          userId: USER_ID,
          name: "env",
          command,
          cwd: null,
          env: { SOMETHING_ELSE: "x" },
        },
        { timeoutMs: TIMEOUT_MS },
      );

      expect(result.serverName).toBe("from-the-account-env");
    },
    TIMEOUT_MS,
  );
});

describe("createWorkspaceMcpTransport", () => {
  it(
    "carries a tool call and its answer over the pipe",
    async () => {
      const command = await writeFakeStdioMcpServer(workspace);
      const client = new McpClient({ name: "saale", version: "1", requestTimeoutMs: TIMEOUT_MS });
      const transport = createWorkspaceMcpTransport({
        userId: USER_ID,
        name: "echo",
        command,
        cwd: null,
        closeTimeoutMs: 300,
      });

      try {
        await client.connect(transport);
        const result = await client.callTool("echo", { text: "hi" });

        // The fake names the tool it was asked for, so the request arrived whole
        // and in order behind the handshake.
        expect(result.content).toEqual([{ type: "text", text: "called echo" }]);
      } finally {
        await client.close();
      }
    },
    TIMEOUT_MS,
  );
});

describe("stopWorkspaceCommands", () => {
  it(
    "ends the commands a chat started when the chat is evicted",
    async () => {
      const command = await writeFakeStdioMcpServer(workspace);
      const client = new McpClient({ name: "saale", version: "1", requestTimeoutMs: TIMEOUT_MS });
      const transport = createWorkspaceMcpTransport({
        userId: USER_ID,
        name: "echo",
        command,
        cwd: null,
        sessionId: "chat-1",
      });

      await client.connect(transport);
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);

      // Evicting the chat does not emit `session_shutdown`, so the transport
      // cannot rely on the extension to close it.
      stopWorkspaceCommands("chat-1");

      await expect
        .poll(
          async () => {
            try {
              await client.listTools();
              return "open";
            } catch {
              return "closed";
            }
          },
          { timeout: 5_000 },
        )
        .toBe("closed");

      // Another chat's command is untouched, and a second eviction is harmless.
      stopWorkspaceCommands("chat-1");
    },
    TIMEOUT_MS,
  );

  it(
    "leaves the command of another chat alone",
    async () => {
      const command = await writeFakeStdioMcpServer(workspace);
      const client = new McpClient({ name: "saale", version: "1", requestTimeoutMs: TIMEOUT_MS });
      const transport = createWorkspaceMcpTransport({
        userId: USER_ID,
        name: "echo",
        command,
        cwd: null,
        sessionId: "chat-2",
      });

      try {
        await client.connect(transport);
        stopWorkspaceCommands("chat-1");
        expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
      } finally {
        await client.close();
      }
    },
    TIMEOUT_MS,
  );
});

describe("workspaceCommandCwd", () => {
  it("resolves a relative directory inside the workspace", () => {
    expect(workspaceCommandCwd(USER_ID, "docs/site")).toBe(path.join(workspace, "docs/site"));
  });

  it("uses the workspace root when no directory is given", () => {
    expect(workspaceCommandCwd(USER_ID, null)).toBe(workspace);
  });

  it("refuses a directory that climbs out of the workspace", () => {
    expect(() => workspaceCommandCwd(USER_ID, "../another-account")).toThrow(FilePathEscapeError);
  });
});
