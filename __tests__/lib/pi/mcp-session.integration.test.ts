/**
 * A configured MCP server, all the way into a live agent session.
 *
 * This is the "configure an MCP and it just works" contract: the server row is
 * read from the database, Pi's MCP extension connects to it during
 * `session_start`, and its tools become callable from codemode scripts. Every
 * earlier step (config building, the connection test, the approval gate) can
 * pass while this one is still broken — for example when a session is never
 * bound, or when the loader ignores the user's servers.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { startFakeMcpServer, type FakeMcpServer } from "../../helpers/fake-mcp-server";

const mockFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { mcpServer: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

import { createUserMcpExtension, loadUserMcpServers } from "@/lib/mcp/servers";
import { createMcpToolPolicyExtension } from "@/lib/pi/mcp-tool-policy";
import { startSessionExtensions } from "@/lib/pi/processing-state";

const USER_ID = "user-1";
const TIMEOUT_MS = 60_000;

let fake: FakeMcpServer;

/** Poll until the MCP extension has registered the server's tools. */
async function waitForMcpTools(session: { getCallableToolNames(): string[] }) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const callable = session.getCallableToolNames();
    if (callable.some((name) => name.startsWith("mcp__fakehome__"))) return callable;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return session.getCallableToolNames();
}

describe("MCP servers in an agent session", () => {
  beforeAll(async () => {
    fake = await startFakeMcpServer({
      tools: [
        { name: "HassTurnOn", description: "Turn something on" },
        { name: "HassTurnOff", description: "Turn something off" },
      ],
    });
  });

  afterAll(async () => {
    await fake.close();
  });

  it(
    "connects the user's server and exposes its tools to codemode",
    async () => {
      mockFindMany.mockResolvedValue([
        {
          id: "srv-1",
          userId: USER_ID,
          name: "fakehome",
          url: fake.url,
          description: "Test house controls",
          encryptedToken: null,
          toolPolicy: "ask",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const { entries, policies } = await loadUserMcpServers(USER_ID);
      expect(entries.map((entry) => entry.name)).toEqual(["fakehome"]);

      const mcp = await createUserMcpExtension(USER_ID);
      expect(mcp).not.toBeNull();

      const loader = new DefaultResourceLoader({
        cwd: "/tmp",
        agentDir: "/tmp/saale-mcp-session-test",
        settingsManager: SettingsManager.inMemory({}),
        systemPrompt: "verify",
        extensionFactories: [
          createCodemodeExtension(),
          mcp!.extension,
          createMcpToolPolicyExtension({
            userId: USER_ID,
            sessionId: "session-1",
            serverPolicies: policies,
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
        expect(session.getActiveToolNames()).toContain("codemode");

        const callable = await waitForMcpTools(session);
        expect(callable).toContain("mcp__fakehome__HassTurnOn");
        expect(callable).toContain("mcp__fakehome__HassTurnOff");

        // No server-to-client stream: an evicted session never emits
        // `session_shutdown`, so Pi would leak one open stream per server per
        // session for the life of the process.
        expect(fake.streamRequests).toBe(0);
      } finally {
        session.dispose();
      }
    },
    TIMEOUT_MS,
  );

  it(
    "never sends the host's shared OAuth credentials",
    async () => {
      const hostServer = await startFakeMcpServer({
        requireToken: "operator-token",
        challenge:
          'Bearer realm="mcp", resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"',
        tools: [],
      });
      // An agent directory whose `mcp-auth.json` holds a sign-in the *operator*
      // (or another tenant with the same name and URL) performed with the Pi
      // CLI. Saale cannot complete a sign-in, so it must never present them.
      const agentDir = await mkdtemp(join(tmpdir(), "saale-mcp-oauth-"));
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const serverUrl = String(new URL(hostServer.url));
      await writeFile(
        join(agentDir, "mcp-auth.json"),
        JSON.stringify({
          [`mcp__hostauth|${serverUrl}`]: {
            serverUrl,
            tokens: { access_token: "operator-token", token_type: "Bearer" },
          },
        }),
      );

      mockFindMany.mockResolvedValue([
        {
          id: "srv-2",
          userId: USER_ID,
          name: "hostauth",
          url: hostServer.url,
          description: "",
          encryptedToken: null,
          toolPolicy: "ask",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      try {
        const mcp = await createUserMcpExtension(USER_ID);
        const loader = new DefaultResourceLoader({
          cwd: "/tmp",
          agentDir: "/tmp/saale-mcp-session-test",
          settingsManager: SettingsManager.inMemory({}),
          systemPrompt: "verify",
          extensionFactories: [createCodemodeExtension(), mcp!.extension],
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
          for (let attempt = 0; attempt < 40; attempt++) {
            if (hostServer.requests.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const sent = hostServer.requests.map((request) => request.authorization);
          expect(sent.length).toBeGreaterThan(0);
          expect(sent).not.toContain("Bearer operator-token");
          expect(session.getCallableToolNames().filter((n) => n.startsWith("mcp__"))).toEqual([]);
        } finally {
          session.dispose();
        }
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await hostServer.close();
        await rm(agentDir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  it("builds no MCP extension for a user without servers", async () => {
    mockFindMany.mockResolvedValue([]);
    expect(await createUserMcpExtension(USER_ID)).toBeNull();
  });
});
