import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import {
  ModelRuntime,
  SettingsManager,
  SessionManager,
  createAgentSession,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { rewindSessionToMessage } from "@/lib/pi/message-rewind";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";

/**
 * Editing a message against the real SDK (Pi's own prompt path).
 *
 * The DB is rewritten on an edit (message updated, everything after it
 * deleted), but the transcript Pi builds its requests from is append-only.
 * `rewindSessionToMessage` moves its leaf back to the edited message's parent,
 * and the prompt that follows has to reach the model as a replacement: the
 * edited text in place of the old one, with the reply the edit deleted gone.
 *
 * These tests assert on what the provider actually receives, so a rewind that
 * only moves the leaf (or one the SDK stops honouring) fails here instead of
 * shipping a chat that answers the original message.
 */

// ─── Mock provider ───────────────────────────────────────────────────────────

/** Every request body the provider saw, in order. */
const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];

function streamChunk(text: string, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
  })}\n\n`;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: string) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      requests.push(JSON.parse(body) as (typeof requests)[number]);
    } catch (err) {
      console.error("Failed to parse mock provider request body:", err);
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(streamChunk("reply", null));
    res.write(streamChunk("", "stop"));
    res.end("data: [DONE]\n\n");
  });
});

let runtime: ModelRuntime;
let testModel: NonNullable<ReturnType<ModelRuntime["getModel"]>>;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  runtime = await ModelRuntime.create({ refreshOnCreate: false });
  runtime.registerProvider("mock", {
    baseUrl: `http://127.0.0.1:${port}/v1`,
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
  testModel = runtime.getModel("mock", "test-model")!;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
});

/** A session over an in-memory transcript, like a chat's own. */
async function newSession(): Promise<AgentSession> {
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    modelRuntime: runtime,
    noTools: "builtin",
    model: testModel,
    customTools: [],
    resourceLoader: await createSystemPromptLoader("You are a test.", process.cwd()),
    thinkingLevel: "off",
  });
  return session;
}

/** The user text the provider received for a request. */
function userTexts(index: number): string[] {
  return requests[index]!.messages.filter((message) => message.role === "user").map((message) => {
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text",
      )
      .map((block) => block.text)
      .join("");
  });
}

/** ALPHA → answer, BETA → answer. */
async function twoTurns(session: AgentSession): Promise<void> {
  await session.prompt("ALPHA");
  await session.prompt("BETA");
}

describe("an edited message, as the provider sees it", () => {
  it("replaces the old message and the reply the edit deleted", async () => {
    const session = await newSession();
    try {
      await twoTurns(session);
      await rewindSessionToMessage(session, { userMessageIndex: 1, previousContent: "BETA" });
      await session.prompt("BETA EDITED");

      // Third request: the edited turn, and nothing of the turn it replaced.
      expect(userTexts(2)).toEqual(["ALPHA", "BETA EDITED"]);
      // One reply left: the answer to ALPHA. the one BETA's edit deleted is gone.
      expect(requests[2]!.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
      // The earlier exchange survives the rewind.
      expect(userTexts(2)[0]).toBe("ALPHA");
    } finally {
      session.dispose();
    }
  });

  it("replaces the first message, leaving the model with only the edit", async () => {
    // The root case: there is no parent message to navigate to, so the leaf
    // takes its parent entry (the session's system entry) instead.
    const session = await newSession();
    try {
      await twoTurns(session);
      await rewindSessionToMessage(session, { userMessageIndex: 0, previousContent: "ALPHA" });
      await session.prompt("ALPHA EDITED");

      expect(userTexts(2)).toEqual(["ALPHA EDITED"]);
    } finally {
      session.dispose();
    }
  });

  it("answers the edit instead of the text it replaced", async () => {
    // The symptom this pins: the chat never continues and the next answer is
    // written against the original message.
    const session = await newSession();
    try {
      await twoTurns(session);
      await rewindSessionToMessage(session, { userMessageIndex: 1, previousContent: "BETA" });
      await session.prompt("BETA EDITED");

      const last = session.messages[session.messages.length - 1]!;
      expect(last.role).toBe("assistant");
      expect(JSON.stringify(last)).toContain("reply");
      expect(userTexts(2)).not.toContain("BETA");
    } finally {
      session.dispose();
    }
  });

  it("keeps the replaced turn in the transcript, off the active branch", async () => {
    // An append-only transcript must not lose the abandoned branch: only the
    // provider context moves on.
    const session = await newSession();
    try {
      await twoTurns(session);
      await rewindSessionToMessage(session, { userMessageIndex: 1, previousContent: "BETA" });
      await session.prompt("BETA EDITED");

      const entries = session.sessionManager.getEntries();
      expect(entries.length).toBeGreaterThan(4);
      expect(JSON.stringify(entries)).toContain("BETA");
    } finally {
      session.dispose();
    }
  });
});
