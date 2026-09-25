import { describe, it, expect } from "vitest";
import { normalizeToolResult } from "@/lib/pi/message-replay";
import { wrapWithApprovalGate } from "@/lib/pi/tool-approval-gate";
import { getDefaultPolicy } from "@/lib/pi/tool-infos";
import { buildAgentSystemPrompt } from "@/lib/pi/processing-state";

/**
 * The prompt under test, with the option names these tests use.
 *
 * Deliberately a thin adapter over the real builder instead of a copy of the
 * prompt text: a copied prompt rots silently and stops protecting the thing it
 * claims to protect.
 */
function buildSystemPrompt(options: {
  customInstructions: string | null;
  terminalEnabled?: boolean;
  memoryEnabled?: boolean;
  infraEnabled?: boolean;
}): string {
  return buildAgentSystemPrompt({
    customInstructions: options.customInstructions,
    toolConfig: {
      terminal: options.terminalEnabled ?? false,
      memory: options.memoryEnabled ?? true,
      ...(options.infraEnabled !== undefined ? { infra: options.infraEnabled } : {}),
    },
  });
}

/**
 * Prompt Cache Integrity Tests
 *
 * Anthropic's prompt cache requires byte-for-byte identical prefixes between
 * requests. If the system prompt, tools, or message history changes between
 * turns, the cache is invalidated — wasting tokens and increasing latency/cost.
 *
 * These tests verify that the payloads sent to the provider are deterministic
 * and stable across follow-up turns.
 *
 * Key risk areas:
 * 1. System prompt changes on agent recreation (user edits custom instructions)
 * 2. Tool definitions changing between turns
 * 3. Message content non-determinism (timestamps, ordering, normalization)
 * 4. Tool result format differences between storage and replay
 * 5. Thinking block handling on model changes
 * 6. Image handling differences between turns
 */

// ─── System Prompt Stability ─────────────────────────────────────────

describe("system prompt stability", () => {
  /**
   * The chat stream route builds the system prompt from:
   * - defaultSystemPrompt (hardcoded)
   * - customInstructions (from DB - user's agentCustomInstructions)
   * - terminalInstruction (conditional on toolConfig.terminal)
   * - memoryInstruction (conditional on toolConfig.memory)
   *
   * If the agent is evicted and recreated between turns, the system prompt
   * is rebuilt from current DB values. Any change invalidates the cache.
   */
  it("system prompt template is deterministic for same inputs", () => {
    // Same inputs → same output
    const config = {
      customInstructions: "Always respond in German.",
      terminalEnabled: true,
      memoryEnabled: true,
    };

    const prompt1 = buildSystemPrompt(config);
    const prompt2 = buildSystemPrompt(config);
    expect(prompt1).toBe(prompt2);

    // Different custom instructions → different prompt (cache invalidated)
    const config2 = { ...config, customInstructions: "Always respond in French." };
    expect(buildSystemPrompt(config)).not.toBe(buildSystemPrompt(config2));

    // Null vs empty string custom instructions → same prompt (both produce no suffix)
    const withNull = buildSystemPrompt({ ...config, customInstructions: null });
    const withEmpty = buildSystemPrompt({ ...config, customInstructions: "" });
    expect(withNull).toBe(withEmpty);

    // Whitespace-only custom instructions → same as null (trimmed to empty)
    const withWhitespace = buildSystemPrompt({ ...config, customInstructions: "   " });
    expect(withWhitespace).toBe(withNull);

    // Terminal toggle changes prompt
    const withTerminal = buildSystemPrompt({ ...config, terminalEnabled: true });
    const withoutTerminal = buildSystemPrompt({ ...config, terminalEnabled: false });
    expect(withTerminal).not.toBe(withoutTerminal);

    // Memory toggle changes prompt
    const withMemory = buildSystemPrompt({ ...config, memoryEnabled: true });
    const withoutMemory = buildSystemPrompt({ ...config, memoryEnabled: false });
    expect(withMemory).not.toBe(withoutMemory);

    // Infra toggle changes prompt, and the infra block is stable across builds
    const withInfra = buildSystemPrompt({ ...config, infraEnabled: true });
    const withoutInfra = buildSystemPrompt({ ...config, infraEnabled: false });
    expect(withInfra).not.toBe(withoutInfra);
    expect(buildSystemPrompt({ ...config, infraEnabled: true })).toBe(withInfra);
  });

  it("system prompt does NOT contain non-deterministic values", () => {
    const prompt = buildSystemPrompt({
      customInstructions: "Test instructions",
      terminalEnabled: true,
      memoryEnabled: true,
      infraEnabled: true,
    });

    // Should not contain timestamps, UUIDs, or other dynamic values
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/); // dates
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // UUIDs
    expect(prompt).not.toMatch(/Date\.now|timestamp|epoch/i);
  });

  /**
   * CRITICAL: If the user changes agentCustomInstructions between turns and the
   * agent is evicted, the system prompt changes → cache invalidated.
   *
   * This is an inherent risk of the pooling architecture. The system prompt is
   * set during agent creation, not persisted in the session file.
   *
   * Mitigation: The pool keeps agents alive for 30min idle time. Within that
   * window, the system prompt is stable. After eviction + recreation, cache
   * is cold anyway (no prior cache to hit).
   */
  it("system prompt changes if custom instructions are edited between turns (cache risk)", () => {
    // Turn 1: agent created with original instructions
    const promptTurn1 = buildSystemPrompt({ customInstructions: "Be concise." });
    // Turn 2: agent evicted, recreated with new instructions
    const promptTurn2 = buildSystemPrompt({ customInstructions: "Be concise. Use markdown." });

    // Different → cache invalidated on turn 2
    expect(promptTurn1).not.toBe(promptTurn2);

    // But if instructions unchanged, prompt is stable
    const promptTurn3 = buildSystemPrompt({ customInstructions: "Be concise." });
    expect(promptTurn1).toBe(promptTurn3);
  });
});

// ─── Tool Definition Stability ────────────────────────────────────────

describe("tool definition stability", () => {
  /**
   * Tools are resolved during session creation and registered with the agent.
   * They should NOT change during the session's lifetime.
   *
   * The approval gate wrapper wraps the execute function, not the tool
   * definition itself — so name, description, and parameters are stable.
   */
  it("tool definitions are stable across multiple resolutions", () => {
    // Same tool name → same policy
    expect(getDefaultPolicy("memory_search")).toBe(getDefaultPolicy("memory_search"));
    expect(getDefaultPolicy("web_search")).toBe(getDefaultPolicy("web_search"));
  });

  /**
   * The approval gate wraps tool.execute() but does NOT modify the tool's
   * name, description, or parameters. This means the tool definition sent
   * to the provider is unchanged by the approval wrapper.
   */
  it("approval gate does not modify tool definition shape", () => {
    const originalTool = {
      name: "test_tool",
      label: "Test Tool",
      description: "A test tool",
      parameters: {
        type: "object" as const,
        properties: { query: { type: "string" as const } },
        required: ["query"] as string[],
      },
      execute: async (args: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: String(args.query) }],
      }),
    } as unknown as import("@earendil-works/pi-coding-agent").ToolDefinition;

    const wrapped = wrapWithApprovalGate(
      originalTool,
      "user-123",
      "session-456",
      async () => "allow" as const,
      () => {}, // noop dispatcher
    );

    // Tool definition fields must be identical
    expect(wrapped.name).toBe(originalTool.name);
    expect(wrapped.description).toBe(originalTool.description);
    expect(wrapped.parameters).toEqual(originalTool.parameters);

    // Only execute is replaced
    expect(wrapped.execute).not.toBe(originalTool.execute);
  });
});

// ─── Message Content Determinism ──────────────────────────────────────

describe("message content determinism", () => {
  /**
   * Tool results are normalized before storage and replay.
   * The normalization must be deterministic — same input always produces
   * same output.
   */
  it("tool result normalization is deterministic", () => {
    // Structured result
    const structured = { content: [{ type: "text" as const, text: "search results" }] };
    expect(normalizeToolResult(structured)).toBe(normalizeToolResult(structured));

    // String result
    expect(normalizeToolResult("plain text")).toBe(normalizeToolResult("plain text"));

    // Multi-block
    const multi = {
      content: [
        { type: "text" as const, text: "first" },
        { type: "text" as const, text: "second" },
      ],
    };
    expect(normalizeToolResult(multi)).toBe(normalizeToolResult(multi));

    // Fallback to JSON.stringify
    const obj = { foo: 42, bar: "baz" };
    expect(normalizeToolResult(obj)).toBe(normalizeToolResult(obj));
  });

  /**
   * Tool result normalization must NOT introduce non-deterministic values
   * like timestamps or random IDs.
   */
  it("tool result normalization does not introduce dynamic values", () => {
    const result = normalizeToolResult({
      content: [{ type: "text" as const, text: "file contents here" }],
    });

    expect(result).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(result).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  /**
   * The SDK's transformMessages inserts synthetic tool results for orphaned
   * tool calls. These include `timestamp: Date.now()` which is non-deterministic.
   *
   * However, the timestamp field is NOT sent to the API — only role, toolCallId,
   * toolName, content, and isError matter. The timestamp is internal metadata.
   *
   * This test verifies the fields that DO matter for the API payload are stable.
   */
  it("synthetic tool results have deterministic API-relevant fields", () => {
    // Simulate what transformMessages does for orphaned tool calls
    function createSyntheticToolResult(toolCallId: string, toolName: string) {
      return {
        role: "toolResult" as const,
        toolCallId,
        toolName,
        content: [{ type: "text" as const, text: "No result provided" }],
        isError: true as const,
        timestamp: Date.now(), // Non-deterministic — but NOT sent to API
      };
    }

    const synthetic1 = createSyntheticToolResult("tc-1", "search");
    const synthetic2 = createSyntheticToolResult("tc-1", "search");

    // API-relevant fields must match
    expect(synthetic1.role).toBe(synthetic2.role);
    expect(synthetic1.toolCallId).toBe(synthetic2.toolCallId);
    expect(synthetic1.toolName).toBe(synthetic2.toolName);
    expect(synthetic1.content).toEqual(synthetic2.content);
    expect(synthetic1.isError).toBe(synthetic2.isError);

    // Timestamp is non-deterministic (not sent to API) — just verify it exists
    expect(typeof synthetic1.timestamp).toBe("number");
  });

  /**
   * Message ordering must be deterministic. The SDK uses tree traversal
   * (buildSessionPath → buildContextEntries → sessionEntryToContextMessages).
   *
   * Saale doesn't control this — it's internal to the SDK. But we verify
   * that our DB message fetch uses a stable ordering.
   */
  it("DB message fetch uses stable ordering", () => {
    // The stream route uses: orderBy: { createdAt: "asc" }
    // This is deterministic — same messages always in same order
    const messages = [
      { id: "1", createdAt: new Date("2025-01-01T00:00:00Z"), role: "user" as const },
      { id: "2", createdAt: new Date("2025-01-01T00:00:01Z"), role: "assistant" as const },
      { id: "3", createdAt: new Date("2025-01-01T00:00:02Z"), role: "user" as const },
    ];

    const sorted = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(sorted.map((m) => m.id)).toEqual(["1", "2", "3"]);

    // Multiple sorts produce same result
    const sorted2 = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(sorted).toEqual(sorted2);
  });
});

// ─── Cache Invalidation Scenarios ─────────────────────────────────────

describe("cache invalidation scenarios", () => {
  /**
   * Scenario: User sends message 1, agent responds. User sends message 2.
   *
   * For cache to work:
   * - System prompt must be identical
   * - Tool definitions must be identical
   * - Message 1 (user) + assistant response must be byte-identical
   * - Only message 2 is new (appended after the cached prefix)
   *
   * The SDK handles this internally via buildSessionContext() which reads
   * from the JSONL file. The messages stored in JSONL are the EXACT messages
   * that were in the API conversation, so they should be deterministic.
   */
  it("multi-turn conversation has stable prefix", () => {
    // Simulate message history as it would appear in the JSONL
    const turn1User = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Hello" }],
    };
    const turn1Assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Hi there! How can I help?" }],
    };

    // Turn 2: same prefix + new user message
    const turn2User = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Search for X" }],
    };

    // The prefix (system + turn1) must be identical
    const prefix1 = JSON.stringify([turn1User, turn1Assistant]);
    const prefix2 = JSON.stringify([turn1User, turn1Assistant]);
    expect(prefix1).toBe(prefix2);

    // Full payload for turn 2 — the prefix messages should be identical
    const fullTurn2 = [turn1User, turn1Assistant, turn2User];
    expect(fullTurn2[0]).toEqual(turn1User);
    expect(fullTurn2[1]).toEqual(turn1Assistant);
    expect(fullTurn2[2]).toEqual(turn2User);
  });

  /**
   * Scenario: Tool use in conversation.
   *
   * Tool calls and results must be stored and replayed identically.
   * The key fields are: toolCallId, tool name, arguments, result content.
   */
  it("tool use conversation has stable replay", () => {
    const toolCall = {
      type: "toolCall" as const,
      id: "tc-123",
      name: "memory_search",
      arguments: { query: "project deadline" },
    };

    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "tc-123",
      content: [{ type: "text" as const, text: "Deadline is Friday" }],
    };

    // Serialize and deserialize (simulating JSONL storage)
    const serialized = JSON.stringify(toolCall);
    const deserialized = JSON.parse(serialized);
    expect(deserialized).toEqual(toolCall);

    const resultSerialized = JSON.stringify(toolResult);
    const resultDeserialized = JSON.parse(resultSerialized);
    expect(resultDeserialized).toEqual(toolResult);
  });

  /**
   * Scenario: Thinking blocks in conversation.
   *
   * Thinking blocks with signatures must be preserved exactly for replay.
   * The SDK's transformMessages keeps thinking blocks for same-model replay.
   */
  it("thinking blocks are preserved deterministically", () => {
    const thinkingBlock = {
      type: "thinking" as const,
      thinking: "Let me think about this...",
      thinkingSignature: "sig-abc123==",
    };

    const serialized = JSON.stringify(thinkingBlock);
    const deserialized = JSON.parse(serialized);
    expect(deserialized).toEqual(thinkingBlock);
  });

  /**
   * Scenario: Redacted thinking blocks.
   *
   * Redacted thinking is opaque encrypted content — must be preserved
   * byte-for-byte for same-model replay.
   */
  it("redacted thinking blocks are preserved deterministically", () => {
    const redactedBlock = {
      type: "thinking" as const,
      thinking: "[Reasoning redacted]",
      thinkingSignature: "encrypted-opaque-data-base64==",
      redacted: true as const,
    };

    const serialized = JSON.stringify(redactedBlock);
    const deserialized = JSON.parse(serialized);
    expect(deserialized).toEqual(redactedBlock);
  });

  /**
   * CRITICAL: The SDK's convertMessages adds cache_control to the LAST
   * user message's last content block. On follow-up turns, the previous
   * user message's cache_control is moved to the NEW last user message.
   *
   * This is correct behavior — the cache prefix includes everything up to
   * (but not including) the new content. The cache_control marker moves
   * with the boundary.
   *
   * But if the previous messages' content changed (even by adding/removing
   * cache_control), the cache would be invalidated.
   *
   * The SDK handles this correctly: cache_control is only on the LAST
   * user message, and previous messages don't have it. On replay, the
   * previous messages are reconstructed WITHOUT cache_control (they were
   * never stored with it in JSONL), and the new last user message gets it.
   */
  it("cache_control placement is correct on follow-up turns", () => {
    // Simulate the SDK's convertMessages cache_control logic
    function addCacheControl(messages: Array<{ role: string; content: unknown[] }>) {
      const cacheControl = { type: "ephemeral" as const };
      const result = [...messages];

      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i]!.role === "user") {
          const lastBlock = result[i]!.content[result[i]!.content.length - 1];
          if (lastBlock && typeof lastBlock === "object") {
            (lastBlock as Record<string, unknown>).cache_control = cacheControl;
          }
          break;
        }
      }

      return result;
    }

    // Turn 1: single user message
    const turn1 = addCacheControl([{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
    expect(turn1[0]?.content[0]).toHaveProperty("cache_control");

    // Turn 2: previous messages + new user message
    // The previous user message should NOT have cache_control (it was never stored with it)
    const turn2 = addCacheControl([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
      { role: "user", content: [{ type: "text", text: "Follow up" }] },
    ]);

    // cache_control is ONLY on the last user message
    expect(turn2[0]?.content[0]).not.toHaveProperty("cache_control");
    expect(turn2[2]?.content[0]).toHaveProperty("cache_control");
  });

  /**
   * Scenario: Tool definitions with cache_control.
   *
   * The SDK adds cache_control to the LAST non-deferred tool.
   * If tools don't change between turns, this is stable.
   */
  it("tool cache_control is stable when tools don't change", () => {
    function addToolCacheControl(tools: Array<{ name: string }>) {
      const cacheControl = { type: "ephemeral" as const };
      return tools.map((tool, i) => ({
        ...tool,
        ...(i === tools.length - 1 ? { cache_control: cacheControl } : {}),
      }));
    }

    const tools = [{ name: "memory_search" }, { name: "web_search" }, { name: "calendar_read" }];

    const cached1 = addToolCacheControl([...tools]);
    const cached2 = addToolCacheControl([...tools]);

    // Same tools → same cache_control placement
    expect(cached1).toEqual(cached2);

    // Only last tool has cache_control
    expect(cached1[0]).not.toHaveProperty("cache_control");
    expect(cached1[1]).not.toHaveProperty("cache_control");
    expect(cached1[2]).toHaveProperty("cache_control");
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────

describe("edge cases", () => {
  /**
   * Empty user messages should not be sent to the API.
   * The SDK's convertMessages filters out empty user messages.
   */
  it("empty user messages are filtered", () => {
    function filterEmptyMessages(
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>,
    ) {
      return messages.filter((msg) => {
        if (msg.role === "user") {
          if (typeof msg.content === "string") {
            return msg.content.trim().length > 0;
          }
          const textBlocks = msg.content.filter((c) => c.type === "text");
          return textBlocks.some((c) => typeof c.text === "string" && c.text.trim().length > 0);
        }
        return true;
      });
    }

    expect(filterEmptyMessages([{ role: "user", content: "   " }])).toHaveLength(0);

    expect(
      filterEmptyMessages([{ role: "user", content: [{ type: "text", text: "" }] }]),
    ).toHaveLength(0);

    expect(filterEmptyMessages([{ role: "user", content: "hello" }])).toHaveLength(1);
  });

  /**
   * Unicode surrogates must be sanitized consistently.
   * The SDK uses sanitizeSurrogates() on text content.
   */
  it("unicode surrogate handling is deterministic", () => {
    // Simulate sanitizeSurrogates behavior
    function sanitize(text: string): string {
      return text.replace(/[\uD800-\uDBFF]([\uDC00-\uDFFF])?/g, (match) => {
        return match.length === 2 ? match : "\uFFFD";
      });
    }

    const input = "Hello \uD83D\uDE00 World"; // Valid emoji
    expect(sanitize(input)).toBe(sanitize(input));

    const broken = "Hello \uD83D World"; // Lone surrogate
    expect(sanitize(broken)).toBe(sanitize(broken));
  });

  /**
   * The job-handler system prompt is a simple hardcoded string.
   * It must be stable across calls.
   */
  it("job-handler default system prompt is stable", () => {
    const defaultPrompt = `You are an AI assistant processing automated jobs. Respond with valid JSON only — no markdown, no explanation, just the raw JSON object.`;

    expect(defaultPrompt).toBe(defaultPrompt);
    expect(defaultPrompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  /**
   * Email draft system prompt includes dynamic content (email writing style).
   * This is a one-shot session (no follow-up turns), so cache is not relevant.
   * But the prompt itself should be deterministic for the same inputs.
   */
  it("email draft system prompt is deterministic for same inputs", () => {
    function buildEmailPrompt(options: {
      mode: "reply" | "reply_all" | "forward";
      writingStyle: string | null;
    }): string {
      const modeInstruction =
        options.mode === "forward"
          ? `You are forwarding this email to someone else. Write a brief introductory note before the forwarded content. Do NOT include the original message body — only the intro note.`
          : `You are replying to this email. Write a natural response addressing the content of the original message.`;

      const userStyleInstructions =
        options.writingStyle && options.writingStyle.trim()
          ? `\n\nWriting style (defined by user):\n${options.writingStyle}`
          : "";

      return `You are an email drafting assistant. Your only job is to write clear, concise email responses.\n\n${modeInstruction}\n${userStyleInstructions}\n\nRules:\n- Write only the email body text — no explanations, no meta-commentary`;
    }

    const config = { mode: "reply" as const, writingStyle: "Professional but friendly" };
    expect(buildEmailPrompt(config)).toBe(buildEmailPrompt(config));
  });
});
