/**
 * The extensions Saale runs, and the bootstrap that starts them.
 *
 * Two things are easy to get wrong and would only show up as "the assistant
 * cannot use codemode / MCP" in production:
 *
 * 1. Pi emits `session_start` only from `bindExtensions()`, and registers
 *    `codemode` inactive. A session that is never bound has no codemode tool and
 *    connects no MCP servers  so `startSessionExtensions` must both bind and
 *    activate.
 * 2. Built-in tools must stay disabled: Saale supplies its own file/shell tools
 *    through Open Terminal, and activating Pi's would give the model the app
 *    server's filesystem.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { mcpServer: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

import { createAgentResourceLoader, startSessionExtensions } from "@/lib/pi/processing-state";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** A runtime that never reads the host's Pi credentials. */
async function modelRuntime() {
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
}

/** A minimal custom tool with a given exposure. */
function customTool(name: string, exposure?: ToolDefinition["exposure"]): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} does a thing`,
    parameters: Type.Object({}),
    ...(exposure ? { exposure } : {}),
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
  } as unknown as ToolDefinition;
}

/** A session with a real codemode extension, built like Saale builds one. */
async function buildSession(customTools: ToolDefinition[] = [], prompt = "You are a test.") {
  const resourceLoader = await createAgentResourceLoader({
    prompt,
    cwd: "/tmp/saale-ext-test",
  });
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory("/tmp/saale-ext-test"),
    modelRuntime: await modelRuntime(),
    noTools: "builtin",
    customTools,
    resourceLoader,
  });
  return session;
}

describe("agent extensions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
    process.env.UPLOADS_DIR = "/tmp/saale-ext-test-uploads";
  });

  it("keeps the built-in tools inactive  Saale supplies its own", async () => {
    const session = await buildSession();
    try {
      expect(session.getActiveToolNames()).not.toContain("bash");
      expect(session.getActiveToolNames()).not.toContain("read");
    } finally {
      session.dispose();
    }
  });

  it("signals that codemode is registered but not yet active", async () => {
    const session = await buildSession();
    try {
      expect(session.getAllTools().map((tool) => tool.name)).toContain("codemode");
      expect(session.getActiveToolNames()).not.toContain("codemode");
    } finally {
      session.dispose();
    }
  });

  it("enables codemode for the session", async () => {
    const session = await buildSession();
    try {
      await startSessionExtensions(session);
      expect(session.getActiveToolNames()).toContain("codemode");
      // Codemode can call the other tools; it is never a tool itself.
      expect(session.getCallableToolNames()).not.toContain("codemode");
    } finally {
      session.dispose();
    }
  });

  it("is idempotent  a second bootstrap does not duplicate the tool", async () => {
    const session = await buildSession();
    try {
      await startSessionExtensions(session);
      const once = session.getActiveToolNames();
      await startSessionExtensions(session);
      expect(session.getActiveToolNames()).toEqual(once);
    } finally {
      session.dispose();
    }
  });

  it("keeps codemode-exposure tools callable but out of the model's declarations", async () => {
    // The whole point of tool exposure: a codemode/deferred tool must be a real
    // registered tool a script can call, and must not be declared to the model.
    // Verified against the real SDK, not just the flags Saale sets.
    const session = await buildSession([
      customTool("direct_tool"),
      customTool("codemode_tool", "codemode"),
      customTool("deferred_tool", "deferred"),
    ]);
    try {
      await startSessionExtensions(session);

      const declared = session.getActiveToolNames();
      expect(declared).toContain("direct_tool");
      expect(declared).not.toContain("codemode_tool");
      expect(declared).not.toContain("deferred_tool");

      const callable = session.getCallableToolNames();
      expect(callable).toContain("codemode_tool");
      expect(callable).toContain("deferred_tool");
    } finally {
      session.dispose();
    }
  });

  it("keeps our custom prompt and adds no Pi default sections", async () => {
    // Pi treats a custom prompt differently: the custom text becomes the
    // preamble and the tools/rules/docs sections are skipped. Hidden tools must
    // therefore be reachable through codemode's own declaration instead.
    const session = await buildSession([customTool("codemode_tool", "codemode")], "You are Saale.");
    try {
      await startSessionExtensions(session);

      const prompt = session.systemPrompt;
      expect(prompt).toContain("You are Saale.");
      expect(prompt).not.toContain("expert coding assistant");
      expect(prompt).not.toContain("<tools>");
      expect(prompt).not.toContain("<rules>");
      expect(prompt).not.toContain("<docs>");
      expect(prompt).toContain("<cwd>");

      // The codemode declaration the request carries lists what scripts reach.
      const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
      expect(codemode?.description).toContain("codemode_tool");
    } finally {
      session.dispose();
    }
  });
});
