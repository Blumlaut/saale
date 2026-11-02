import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { Type } from "typebox";

/**
 * What a coder chat's gate does to a real tool call, all the way through Pi.
 *
 * The unit tests in `tool-approval-extension.test.ts` call the gate's handler
 * with a fake extension API. This drives the same gate the way a chat does: a
 * model answers with a `bash` tool call, Pi's own pipeline hands it to the gate,
 * and the tool either runs or the model is told it was refused. That is the path
 * a wrong verdict breaks, and it is what a session actually goes through.
 *
 * The approval channel is mocked: whether a card reaches the browser is the
 * gate's own tests' business, and waiting out a real 5-minute timeout is not
 * something a test can do.
 */

const mockRequestToolApproval = vi.fn();
vi.mock("@/lib/pi/tool-approval-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pi/tool-approval-gate")>();
  return {
    ...actual,
    requestToolApproval: (...args: unknown[]) => mockRequestToolApproval(...args),
  };
});

const mockIsAutoApproveActive = vi.fn();
vi.mock("@/lib/pi/auto-approve", () => ({
  isAutoApproveActive: (...args: unknown[]) => mockIsAutoApproveActive(...args),
}));

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { createToolApprovalExtension } from "@/lib/pi/tool-approval-extension";

const WORKSPACE = { root: "/w/user-1", cwd: "/w/user-1/projects/shop/worktrees/chat-1" };

// ─── Mock provider ───────────────────────────────────────────────────────────

/** What the next request is answered with: a `bash` call, or a plain reply. */
let nextCommand: string | null = null;
let requests = 0;

const PORT = 36_917;

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const server = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });

    if (nextCommand !== null) {
      const command = nextCommand;
      // One tool call per prompt: the next request gets the plain answer, which
      // is where a blocked call has to leave the run still alive.
      nextCommand = null;
      res.write(
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command }) },
              },
            ],
          },
          null,
        ),
      );
      res.write(chunk({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
      return;
    }

    res.write(chunk({ content: "done" }, null));
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
});

// ─── Harness ─────────────────────────────────────────────────────────────────

let runtime: ModelRuntime;
let TEST_MODEL: NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** Commands the fake `bash` tool was actually asked to run. */
let executed: string[] = [];

const bashTool = defineTool({
  name: "bash",
  label: "Bash",
  description: "Execute shell commands",
  parameters: Type.Object({ command: Type.String() }),
  execute: async (_toolCallId, params) => {
    executed.push(params.command);
    return {
      content: [{ type: "text" as const, text: `ran ${params.command}` }],
      details: undefined,
    };
  },
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  runtime = await ModelRuntime.create({ refreshOnCreate: false });
  runtime.registerProvider("mock", {
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: "test-model",
        name: "test-model",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      },
    ],
  });
  TEST_MODEL = runtime.getModel("mock", "test-model")!;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  executed = [];
  requests = 0;
  nextCommand = null;
  vi.clearAllMocks();
  mockIsAutoApproveActive.mockResolvedValue(false);
  mockRequestToolApproval.mockResolvedValue("approved");
});

afterEach(() => {
  vi.restoreAllMocks();
});

let sessionSequence = 0;

/**
 * Ask the model to run `command` in a session whose gate has `gate` options.
 *
 * Resolves once the run is over. A rejected promise is the failure this suite
 * exists to rule out: a gate that throws takes the whole run with it.
 */
async function runCommand(
  command: string,
  gate: Partial<Parameters<typeof createToolApprovalExtension>[0]> = {},
): Promise<void> {
  sessionSequence += 1;
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager: SettingsManager.inMemory(),
    systemPrompt: "You are a test.",
    extensionFactories: [
      createToolApprovalExtension({
        userId: "user-1",
        sessionId: `session-${sessionSequence}`,
        toolPolicies: null,
        emitApprovalRequest: () => {},
        ...gate,
      }),
    ],
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    noSkills: true,
    appendSystemPrompt: [],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    modelRuntime: runtime,
    noTools: "builtin",
    model: TEST_MODEL,
    customTools: [bashTool],
    resourceLoader: loader,
    thinkingLevel: "off",
  });

  nextCommand = command;
  try {
    await session.prompt("run it");
  } finally {
    session.dispose();
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("a coder chat's tool call, through the real session", () => {
  it("runs a command that stays inside the workspace, without a card", async () => {
    await runCommand("npm install && npm test > out.txt", { commandScope: WORKSPACE });

    expect(executed).toEqual(["npm install && npm test > out.txt"]);
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
    // The model kept its turn: one tool call, then the reply that ends the run.
    expect(requests).toBe(2);
  });

  it("holds back a command that leaves the workspace until it is approved", async () => {
    mockRequestToolApproval.mockResolvedValue("denied");

    await runCommand("git push origin main", { commandScope: WORKSPACE });

    expect(executed).toEqual([]);
    expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash", args: { command: "git push origin main" } }),
    );
    // A refused call is a tool result, not the end of the run.
    expect(requests).toBe(2);
  });

  it("runs the same command once it is approved", async () => {
    await runCommand("git push origin main", { commandScope: WORKSPACE });

    expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
    expect(executed).toEqual(["git push origin main"]);
  });

  it("follows the user's own policy when the tool is set to allow", async () => {
    await runCommand("git push origin main", {
      commandScope: WORKSPACE,
      toolPolicies: { bash: "allow" },
    });

    expect(executed).toEqual(["git push origin main"]);
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
  });

  it("asks about a path outside the workspace", async () => {
    mockRequestToolApproval.mockResolvedValue("denied");

    await runCommand("cat /w/user-2/projects/shop/.env", { commandScope: WORKSPACE });

    expect(executed).toEqual([]);
    expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
  });

  it("keeps the old classifier for a chat without a workspace scope", async () => {
    // No commandScope: an ordinary chat's bash still asks about a mutation.
    mockRequestToolApproval.mockResolvedValue("denied");

    await runCommand("rm -rf node_modules");

    expect(executed).toEqual([]);
    expect(mockRequestToolApproval).toHaveBeenCalledTimes(1);
  });
});

describe("when the check itself fails", () => {
  it("blocks the one call and leaves the chat running", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // A scope the classifier cannot read: the shape a bad caller would hand it.
    // A path argument is what reaches it, and what throws.
    const brokenScope = { root: 42, cwd: 42 } as unknown as typeof WORKSPACE;

    await runCommand("cat ../notes.txt", { commandScope: brokenScope });

    expect(executed).toEqual([]);
    // Nothing was decided, so nothing was put to the user either.
    expect(mockRequestToolApproval).not.toHaveBeenCalled();
    // The run finished rather than rejecting: the model was told the call was blocked.
    expect(requests).toBe(2);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('Failed to decide the approval for tool "bash"'),
      expect.anything(),
    );
  });

  it("blocks the call when the approval channel itself throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRequestToolApproval.mockRejectedValue(new Error("redis is down"));

    await runCommand("git push origin main", { commandScope: WORKSPACE });

    expect(executed).toEqual([]);
    expect(requests).toBe(2);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('Failed to decide the approval for tool "bash"'),
      expect.anything(),
    );
  });
});
