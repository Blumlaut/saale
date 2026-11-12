/**
 * A stdio MCP server, all the way into a live agent session.
 *
 * The row, the Pi extension and the session are the real ones; only the program
 * is a stand-in, run through the sandbox service exactly as a configured command
 * would be. What this proves that the transport's own test cannot: a session
 * binds the server at `session_start`, its tools become callable, and closing
 * the session leaves no process behind to keep the container awake.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createCodemodeExtension,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { writeFakeStdioMcpServer } from "../../helpers/fake-stdio-mcp-server";

const mockFindMany = vi.fn();
const mockSharedFindMany = vi.fn();
const mockOAuthFindUnique = vi.fn();
const mockEnvFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    mcpServer: { findMany: (...args: unknown[]) => mockFindMany(...args) },
    sharedMcpServer: { findMany: (...args: unknown[]) => mockSharedFindMany(...args) },
    mcpOAuthCredential: { findUnique: (...args: unknown[]) => mockOAuthFindUnique(...args) },
    sandboxEnvVar: { findMany: (...args: unknown[]) => mockEnvFindMany(...args) },
  },
}));

import { createUserMcpExtension } from "@/lib/mcp/servers";
import { createToolApprovalExtension } from "@/lib/pi/tool-approval-extension";
import { startSessionExtensions } from "@/lib/pi/processing-state";
import { stopWorkspaceCommands } from "@/lib/mcp/stdio";
import { userWorkspacePath } from "@/lib/sandbox/workspace";

const USER_ID = "user-stdio-session";
const TIMEOUT_MS = 60_000;

let workspaces: string;
let previousDir: string | undefined;
let previousUrl: string | undefined;
let command: string;

/** Poll until the MCP extension has registered the server's tools. */
async function waitForMcpTools(session: { getCallableToolNames(): string[] }) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const callable = session.getCallableToolNames();
    if (callable.some((name) => name.startsWith("mcp__fakefiles__"))) return callable;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return session.getCallableToolNames();
}

beforeAll(async () => {
  workspaces = await mkdtemp(join(tmpdir(), "saale-stdio-session-"));
  previousDir = process.env.SANDBOX_WORKSPACES_DIR;
  previousUrl = process.env.SANDBOX_URL;
  process.env.SANDBOX_WORKSPACES_DIR = workspaces;
  delete process.env.SANDBOX_URL;

  const workspace = userWorkspacePath(USER_ID);
  await mkdir(workspace, { recursive: true });
  command = await writeFakeStdioMcpServer(workspace, {
    name: "filesystem",
    markerPath: join(workspace, ".ran"),
    tools: [
      { name: "read_file", description: "Read a file" },
      { name: "list_directory", description: "List a directory" },
    ],
  });

  mockOAuthFindUnique.mockResolvedValue(null);
  mockSharedFindMany.mockResolvedValue([]);
  mockEnvFindMany.mockResolvedValue([]);
});

afterAll(async () => {
  if (previousDir === undefined) delete process.env.SANDBOX_WORKSPACES_DIR;
  else process.env.SANDBOX_WORKSPACES_DIR = previousDir;
  if (previousUrl === undefined) delete process.env.SANDBOX_URL;
  else process.env.SANDBOX_URL = previousUrl;
  await rm(workspaces, { recursive: true, force: true });
});

describe("a stdio MCP server in an agent session", () => {
  it(
    "connects the command at session_start and exposes its tools to codemode",
    async () => {
      mockFindMany.mockResolvedValue([
        {
          id: "srv-stdio",
          userId: USER_ID,
          name: "fakefiles",
          transport: "stdio",
          url: null,
          command,
          cwd: null,
          description: "Files in the workspace",
          encryptedToken: null,
          toolPolicy: "ask",
          enabled: true,
          chatEnabled: true,
          coderEnabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const mcp = await createUserMcpExtension(USER_ID, {
        scope: "chat",
        sessionId: "chat-stdio",
      });
      expect(mcp).not.toBeNull();

      const loader = new DefaultResourceLoader({
        cwd: "/tmp",
        agentDir: "/tmp/saale-stdio-session-test",
        settingsManager: SettingsManager.inMemory({}),
        systemPrompt: "verify",
        extensionFactories: [
          createCodemodeExtension(),
          mcp!.extension,
          createToolApprovalExtension({
            userId: USER_ID,
            sessionId: "session-1",
            mcpServerPolicies: mcp!.policies,
            toolPolicies: null,
            emitApprovalRequest: () => {},
          }),
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();

      const { session } = await createAgentSession({
        sessionManager: SessionManager.inMemory("/tmp"),
        modelRuntime: await ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsPath: null,
        }),
        noTools: "builtin",
        resourceLoader: loader,
      });

      try {
        await startSessionExtensions(session);

        const callable = await waitForMcpTools(session);
        expect(callable).toContain("mcp__fakefiles__read_file");
        expect(callable).toContain("mcp__fakefiles__list_directory");

        // Evicting the chat is what the pool does: disposing the session does
        // not emit `session_shutdown`, so the command would keep running.
        stopWorkspaceCommands("chat-stdio");
        // The program itself ran: the marker is written by the fake before its
        // first read, so the tools came off its own stdin/stdout.
        const marker = await readFile(join(userWorkspacePath(USER_ID), ".ran"), "utf8");
        expect(marker.trim()).toBe("started");
      } finally {
        session.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
