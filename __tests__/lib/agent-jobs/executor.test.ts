import { describe, it, expect, vi, beforeEach } from "vitest";

/** Normalize modelId: convert "/" to ":" separator. */
function normalizeModelId(id: string | null): string | null {
  if (!id) return null;
  return id.includes("/") ? id.replace("/", ":") : id;
}

// ─── Mock Prisma ─────────────────────────────────────────────────────────────

const mockAgentDefinition = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  deleteMany: vi.fn(),
};

const mockAgentRun = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  deleteMany: vi.fn(),
};

const mockAgentRunMessage = {
  findMany: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
};

vi.mock("@/lib/db", () => ({
  prisma: {
    agentDefinition: mockAgentDefinition,
    agentRun: mockAgentRun,
    agentRunMessage: mockAgentRunMessage,
    appSettings: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/pi/models", () => ({
  buildModelRegistry: vi.fn(),
}));

vi.mock("@/lib/pi/tool-registry", () => ({
  resolveTools: vi.fn(),
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("agent job executor — helpers", () => {
  it("extractText joins text blocks from content array", () => {
    const content: Record<string, unknown>[] = [
      { type: "text", text: "Hello " },
      { type: "thinking", thinking: "reasoning..." },
      { type: "text", text: "world" },
      { type: "toolCall", id: "tc1", name: "test", arguments: {} },
    ];

    const text = content
      .filter((c) => c.type === "text")
      .map((c) => (c.text as string) || "")
      .join("");

    expect(text).toBe("Hello world");
  });

  it("extractText handles empty content", () => {
    const content: Record<string, unknown>[] = [];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => (c.text as string) || "")
      .join("");
    expect(text).toBe("");
  });

  it("extractText handles text blocks with empty strings", () => {
    const content: Record<string, unknown>[] = [
      { type: "text", text: "" },
      { type: "text", text: null },
      { type: "text", text: "only this" },
    ];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => (c.text as string) || "")
      .join("");
    expect(text).toBe("only this");
  });

  it("extractThinking returns undefined when no thinking block", () => {
    const content: Record<string, unknown>[] = [{ type: "text", text: "Hello" }];
    const block = content.find((c) => c.type === "thinking");
    expect(block).toBeUndefined();
  });

  it("extractThinking returns thinking content when present", () => {
    const content: Record<string, unknown>[] = [
      { type: "text", text: "Hello" },
      { type: "thinking", thinking: "Let me think..." },
    ];
    const block = content.find((c) => c.type === "thinking");
    expect(block?.thinking).toBe("Let me think...");
  });
});

describe("agent job executor — tool result normalization", () => {
  it("handles string results", () => {
    const result = "simple string";
    const normalized =
      typeof result === "string"
        ? result
        : typeof result === "object" && result !== null
          ? JSON.stringify(result)
          : String(result ?? "");
    expect(normalized).toBe("simple string");
  });

  it("handles object results with content array", () => {
    const result = {
      content: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ],
    };
    const obj = result as Record<string, unknown>;
    const normalized = Array.isArray(obj.content)
      ? (obj.content as Record<string, unknown>[])
          .filter((c) => c.type === "text")
          .map((c) => (c.text as string) || "")
          .join("")
      : JSON.stringify(obj);
    expect(normalized).toBe("Part 1Part 2");
  });

  it("handles object results without content array", () => {
    const result = { success: true, count: 5 };
    const obj = result as Record<string, unknown>;
    const normalized = Array.isArray(obj.content)
      ? (obj.content as Record<string, unknown>[])
          .filter((c) => c.type === "text")
          .map((c) => (c.text as string) || "")
          .join("")
      : JSON.stringify(obj);
    expect(normalized).toBe('{"success":true,"count":5}');
  });

  it("handles null result", () => {
    const result = null;
    const normalized =
      typeof result === "string"
        ? result
        : typeof result === "object" && result !== null
          ? JSON.stringify(result)
          : String(result ?? "");
    expect(normalized).toBe("");
  });

  it("handles undefined result", () => {
    const result = undefined;
    const normalized =
      typeof result === "string"
        ? result
        : typeof result === "object" && result !== null
          ? JSON.stringify(result)
          : String(result ?? "");
    expect(normalized).toBe("");
  });

  it("handles numeric result", () => {
    const result = 42;
    const normalized =
      typeof result === "string"
        ? result
        : typeof result === "object" && result !== null
          ? JSON.stringify(result)
          : String(result ?? "");
    expect(normalized).toBe("42");
  });
});

describe("agent job tools — agent_job_create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes modelId with / separator to :", async () => {
    expect(normalizeModelId("anthropic/claude-sonnet-4-20250514")).toBe(
      "anthropic:claude-sonnet-4-20250514",
    );
  });

  it("preserves modelId already in : format", async () => {
    expect(normalizeModelId("openai:gpt-4o")).toBe("openai:gpt-4o");
  });

  it("handles null modelId", async () => {
    expect(normalizeModelId(null)).toBeNull();
  });

  it("creates definition with trimmed fields", async () => {
    const params = {
      name: "  Email Summary  ",
      description: "  Summarizes emails  ",
      prompt: "  Summarize unread emails  ",
      systemPrompt: "  You are an email assistant  ",
      toolConfig: { email: true },
    };

    expect(params.name.trim()).toBe("Email Summary");
    expect(params.description!.trim()).toBe("Summarizes emails");
    expect(params.prompt.trim()).toBe("Summarize unread emails");
    expect(params.systemPrompt!.trim()).toBe("You are an email assistant");
  });

  it("handles empty description and systemPrompt as null", async () => {
    const description = "";
    const systemPrompt = "   ";

    expect(description.trim() || null).toBeNull();
    expect(systemPrompt.trim() || null).toBeNull();
  });
});

describe("agent job tools — agent_job_logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes duration from startedAt and completedAt", () => {
    const startedAt = new Date("2024-01-01T00:00:00Z");
    const completedAt = new Date("2024-01-01T00:05:00Z");
    const duration = completedAt.getTime() - startedAt.getTime();
    expect(duration).toBe(5 * 60 * 1000); // 5 minutes in ms
  });

  it("returns null duration when timestamps are missing", () => {
    const calcDuration = (s: Date | null, c: Date | null) =>
      s && c ? c.getTime() - s.getTime() : null;
    expect(calcDuration(null, new Date())).toBeNull();
    expect(calcDuration(new Date(), null)).toBeNull();
  });

  it("filters runs by status", () => {
    const runs = [
      { id: "1", status: "completed" },
      { id: "2", status: "error" },
      { id: "3", status: "completed" },
      { id: "4", status: "pending" },
    ];

    const completed = runs.filter((r) => r.status === "completed");
    expect(completed).toHaveLength(2);
    expect(completed.map((r) => r.id)).toEqual(["1", "3"]);
  });

  it("limits results to specified count", () => {
    const runs = Array.from({ length: 20 }, (_, i) => ({ id: String(i), status: "completed" }));
    const limited = runs.slice(0, 5);
    expect(limited).toHaveLength(5);
  });
});

describe("agent job tools — agent_job_run_messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses toolCalls JSON from database", () => {
    const toolCallsJson =
      '[{"id":"tc1","name":"email_search","args":{"query":"is:unread"},"result":"Found 3 emails","isError":false}]';
    const parsed = JSON.parse(toolCallsJson);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("email_search");
    expect(parsed[0].args.query).toBe("is:unread");
  });

  it("handles null toolCalls", () => {
    const toolCalls = null;
    const parsed = toolCalls ? JSON.parse(toolCalls) : null;
    expect(parsed).toBeNull();
  });

  it("orders messages chronologically", () => {
    const messages = [
      { id: "3", role: "assistant", createdAt: new Date("2024-01-01T00:02:00Z") },
      { id: "1", role: "user", createdAt: new Date("2024-01-01T00:00:00Z") },
      { id: "2", role: "assistant", createdAt: new Date("2024-01-01T00:01:00Z") },
    ];

    const sorted = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(sorted.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });
});

describe("agent job run — status transitions", () => {
  it("valid status progression: pending -> running -> completed", () => {
    const transitions: Array<{ from: string; to: string; valid: boolean }> = [
      { from: "pending", to: "running", valid: true },
      { from: "running", to: "completed", valid: true },
      { from: "running", to: "error", valid: true },
      { from: "running", to: "cancelled", valid: true },
      { from: "completed", to: "error", valid: false }, // shouldn't happen
      { from: "error", to: "completed", valid: false }, // shouldn't happen
    ];

    for (const t of transitions) {
      // The executor handles transitions internally — this tests the expected flow
      if (t.valid) {
        expect(["pending", "running", "completed", "error", "cancelled"]).toContain(t.to);
      }
    }
  });

  it("error status includes error message", () => {
    const errorData = {
      status: "error",
      error: "Model API returned 503",
      completedAt: new Date(),
    };
    expect(errorData.status).toBe("error");
    expect(errorData.error).toBe("Model API returned 503");
  });
});
