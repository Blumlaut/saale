/**
 * The extensions Saale runs, and the bootstrap that starts them.
 *
 * Two things are easy to get wrong and would only show up as "the assistant
 * cannot use codemode / MCP" in production:
 *
 * 1. Pi emits `session_start` only from `bindExtensions()`, and registers
 *    `codemode` inactive. A session that is never bound has no codemode tool and
 *    connects no MCP servers — so `startSessionExtensions` must both bind and
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
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

/** A runtime that never reads the host's Pi credentials. */
async function modelRuntime() {
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
}

/** A session with a real codemode extension, built like Saale builds one. */
async function buildSession() {
  const resourceLoader = await createAgentResourceLoader({
    prompt: "You are a test.",
    cwd: "/tmp/saale-ext-test",
  });
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory("/tmp/saale-ext-test"),
    modelRuntime: await modelRuntime(),
    noTools: "builtin",
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

  it("keeps the built-in tools inactive — Saale supplies its own", async () => {
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

  it("is idempotent — a second bootstrap does not duplicate the tool", async () => {
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
});
