import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { buildCoderSystemPrompt } from "@/lib/pi/coder-prompt";
import { normalizeToolResult } from "@/lib/pi/message-replay";
import { buildAgentSystemPrompt } from "@/lib/pi/processing-state";

/**
 * What a prompt cache is made of.
 *
 * Anthropic and OpenAI both cache on an exact byte prefix: the system prompt,
 * the tool definitions, then the transcript up to the previous turn. If any of
 * it is rebuilt differently between requests, the whole conversation is billed
 * again at full price, so the assertions here are about the text staying
 * identical for identical inputs.
 *
 * That the session then sends the prefix unchanged is covered end to end by
 * `prompt-prefix-stability.integration.test.ts`; this file covers the builders
 * those requests are made of.
 */

const CHAT_TOOLS = { terminal: true, memory: true, files: true };
const CODER_TOOLS = { terminal: true, files: true, memory: true, web: true };

describe("the chat prompt", () => {
  const build = (customInstructions: string | null, toolConfig: Record<string, boolean>) =>
    buildAgentSystemPrompt({ customInstructions, toolConfig });

  it("is byte-identical when built twice from the same inputs", () => {
    expect(build("Reply in German.", CHAT_TOOLS)).toBe(build("Reply in German.", CHAT_TOOLS));
  });

  it("treats absent, empty and blank instructions the same way", () => {
    const absent = build(null, CHAT_TOOLS);
    expect(build("", CHAT_TOOLS)).toBe(absent);
    expect(build("   \n ", CHAT_TOOLS)).toBe(absent);
    // Trailing whitespace is trimmed, so it cannot invalidate the prefix.
    expect(build("Reply in German.  ", CHAT_TOOLS)).toBe(build("Reply in German.", CHAT_TOOLS));
  });

  it("changes when the user edits their instructions", () => {
    // The documented cost of the pool: an edit shows up in the next prompt,
    // and a session rebuilt after it starts with a cold cache.
    expect(build("Be concise.", CHAT_TOOLS)).not.toBe(build("Be brief.", CHAT_TOOLS));
  });

  it("changes when a tool category is toggled", () => {
    expect(build(null, { ...CHAT_TOOLS, memory: false })).not.toBe(build(null, CHAT_TOOLS));
  });

  it("carries no value that moves on its own", () => {
    const prompt = build("Test instructions", CHAT_TOOLS);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });
});

describe("the coder prompt", () => {
  const build = (options: Partial<Parameters<typeof buildCoderSystemPrompt>[0]> = {}) =>
    buildCoderSystemPrompt({ toolConfig: CODER_TOOLS, ...options });

  it("is byte-identical when built twice from the same inputs", () => {
    expect(build({ customInstructions: "Prefer pnpm." })).toBe(
      build({ customInstructions: "Prefer pnpm." }),
    );
  });

  it("differs between a worktree and the project's shared checkout", () => {
    // Different identity, different rules: a chat that resumes in the other
    // mode cannot reuse the other one's cache, which is why the mode is fixed
    // when the session is created.
    const worktree = build({ checkout: "worktree" });
    const shared = build({ checkout: "repo" });
    expect(worktree).not.toBe(shared);
    expect(worktree).toContain("one git worktree");
    expect(shared).toContain("shared with every other chat of this project");
  });

  it("names the preview wildcard only when the deployment has a domain", () => {
    const withDomain = build({ previewDomain: "preview.example.com" });
    expect(withDomain).toContain("`https://*.preview.example.com`");
    // Without a domain the rule would name nothing, so it drops out entirely.
    expect(build({ previewDomain: null })).not.toContain("trustedOrigins");
  });

  it("names sandbox variables, never their values", () => {
    const prompt = build({ sandboxEnvNames: ["GH_TOKEN"] });
    expect(prompt).toContain("`GH_TOKEN`");
    // The builder is only ever given names, so nothing else can leak into a
    // prompt that is resent on every request.
    expect(build({ sandboxEnvNames: [] })).not.toContain("GH_TOKEN");
  });

  it("carries no path, date or uuid that would change between turns", () => {
    const prompt = build({ previewDomain: "preview.example.com", customInstructions: "Be terse." });
    expect(prompt).not.toMatch(/\/(?:home|w|tmp|Users)\//);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });
});

describe("tool results", () => {
  it("normalizes to the same string every time", () => {
    const structured = { content: [{ type: "text" as const, text: "the contents" }] };
    expect(normalizeToolResult(structured)).toBe(normalizeToolResult(structured));

    const multi = {
      content: [
        { type: "text" as const, text: "first" },
        { type: "text" as const, text: "second" },
      ],
    };
    expect(normalizeToolResult(multi)).toBe("firstsecond");
    expect(normalizeToolResult({ foo: 42 })).toBe('{"foo":42}');
    expect(normalizeToolResult("plain")).toBe("plain");
  });

  it("replays what was stored without decorating it", () => {
    // The stored value is the text that goes back as a toolResult, so a
    // replayed transcript matches the one the model already answered.
    const stored = normalizeToolResult({ content: [{ type: "text", text: "a file body" }] });
    expect(normalizeToolResult(stored)).toBe(stored);
  });
});

describe("the transcript Pi turns into a request", () => {
  const asMessages = (messages: unknown[]) => messages as AgentMessage[];

  it("passes the provider roles through untouched and in order", () => {
    const transcript = asMessages([
      { role: "system", content: "You are Saale." },
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
        isError: false,
        timestamp: 3,
      },
    ]);

    const converted = convertToLlm(transcript);
    expect(converted).toEqual(transcript);
    expect(converted.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("turns a bash execution into the same user text every time", () => {
    const bash = asMessages([
      {
        role: "bashExecution",
        command: "ls",
        output: "a.ts",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
      },
    ]);

    const first = convertToLlm(bash);
    expect(convertToLlm(bash)).toEqual(first);
    expect(first).toHaveLength(1);
    expect(JSON.stringify(first)).toContain("Ran `ls`");
  });

  it("leaves out a bash execution the user excluded from the context", () => {
    const excluded = asMessages([
      {
        role: "bashExecution",
        command: "ls",
        output: "a.ts",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 1,
      },
    ]);
    expect(convertToLlm(excluded)).toHaveLength(0);
  });

  it("wraps a compaction summary in the text the next request carries", () => {
    const summary = asMessages([
      {
        role: "compactionSummary",
        summary: "we set the schema up",
        tokensBefore: 9000,
        timestamp: 1,
      },
    ]);
    const converted = convertToLlm(summary);

    expect(converted).toHaveLength(1);
    expect(converted[0]?.role).toBe("user");
    expect(JSON.stringify(converted[0])).toContain("we set the schema up");
    // Rebuilding the same transcript rebuilds the same text, timestamp aside.
    expect(convertToLlm(summary)).toEqual(converted);
  });
});
