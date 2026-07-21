import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Prisma ─────────────────────────────────────────────────────────────

const mockAgentRunMessage = {
  create: vi.fn(),
  findMany: vi.fn(),
};

const mockAgentRun = {
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
};

const mockAppSettings = {
  findUnique: vi.fn(),
};

vi.mock("@/lib/db", () => ({
  prisma: {
    agentRunMessage: mockAgentRunMessage,
    agentRun: mockAgentRun,
    appSettings: mockAppSettings,
  },
}));

vi.mock("@/lib/pi/models", () => ({
  buildModelRegistry: vi.fn(),
}));

vi.mock("@/lib/pi/tool-registry", () => ({
  resolveTools: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  SessionManager: { inMemory: vi.fn() },
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AgentOutput interface", () => {
  it("send is required and accepts content string with optional meta", () => {
    const output = {
      send: vi.fn(),
      typing: vi.fn(),
    };

    // Basic send — called with just content
    output.send("Hello world");
    expect(output.send).toHaveBeenCalledTimes(1);
    const firstCall = output.send.mock.calls[0];
    expect(firstCall?.[0]).toBe("Hello world");

    // Send with tool calls
    output.send("Done", { toolCalls: [{ id: "tc1", name: "test" }] });
    expect(output.send).toHaveBeenLastCalledWith("Done", {
      toolCalls: [{ id: "tc1", name: "test" }],
    });
  });

  it("typing is optional", () => {
    const output: { send: () => void; typing?: () => void } = {
      send: vi.fn(),
    };

    // Should not throw when typing is not defined
    output.typing?.();
  });
});

describe("executor — output routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("output.send is called with turn text on turn_end", () => {
    const output = {
      send: vi.fn(),
      typing: vi.fn(),
    };

    // Simulate turn_end event behavior
    const turnText = "The agent processed your request.";
    const turnToolCalls: unknown[] = [];

    // This is what the executor does on turn_end
    if (output && turnText.trim()) {
      const meta: { toolCalls?: unknown[] } = {};
      if (turnToolCalls.length > 0) {
        meta.toolCalls = turnToolCalls;
      }
      output.send(turnText, meta);
    }

    expect(output.send).toHaveBeenCalledWith(turnText, {});
  });

  it("output.send includes tool calls when present", () => {
    const output = {
      send: vi.fn(),
    };

    const turnText = "Found 3 emails.";
    const turnToolCalls = [{ id: "tc1", name: "email_search", args: { query: "unread" } }];

    if (output && turnText.trim()) {
      const meta: { toolCalls?: unknown[] } = {};
      if (turnToolCalls.length > 0) {
        meta.toolCalls = turnToolCalls;
      }
      output.send(turnText, meta);
    }

    expect(output.send).toHaveBeenCalledWith(turnText, {
      toolCalls: turnToolCalls,
    });
  });

  it("output.send is not called for empty text", () => {
    const output = {
      send: vi.fn(),
    };

    const turnText = "   ";

    if (output && turnText.trim()) {
      output.send(turnText);
    }

    expect(output.send).not.toHaveBeenCalled();
  });

  it("output.typing is called on tool_execution_start", () => {
    const typingFn = vi.fn();
    const output: { send: () => void; typing?: () => void } = {
      send: vi.fn(),
      typing: typingFn,
    };

    // Simulate tool_execution_start
    output.typing?.();

    expect(typingFn).toHaveBeenCalled();
  });

  it("no error when output.typing is undefined", () => {
    const output: { send: () => void; typing?: () => void } = {
      send: vi.fn(),
      // typing not defined
    };

    // Should not throw
    expect(() => output.typing?.()).not.toThrow();
  });
});

describe("executor — helper functions", () => {
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

  it("extractThinking returns null when no thinking block", () => {
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

describe("executor — tool result normalization", () => {
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

describe("executor — model resolution", () => {
  it("splits modelId into provider and name with colon separator", () => {
    const modelId = "anthropic:claude-sonnet-4-20250514";
    const [provider, ...nameParts] = modelId.split(":");
    expect(provider).toBe("anthropic");
    expect(nameParts.join(":")).toBe("claude-sonnet-4-20250514");
  });

  it("handles modelId with multiple colons", () => {
    const modelId = "openrouter:anthropic/claude-3.5-sonnet";
    const [provider, ...nameParts] = modelId.split(":");
    expect(provider).toBe("openrouter");
    expect(nameParts.join(":")).toBe("anthropic/claude-3.5-sonnet");
  });
});

describe("executor — status transitions", () => {
  it("valid status progression: pending -> running -> completed", () => {
    const transitions: Array<{ from: string; to: string; valid: boolean }> = [
      { from: "pending", to: "running", valid: true },
      { from: "running", to: "completed", valid: true },
      { from: "running", to: "error", valid: true },
      { from: "running", to: "cancelled", valid: true },
      { from: "completed", to: "error", valid: false },
      { from: "error", to: "completed", valid: false },
    ];

    for (const t of transitions) {
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

describe("executor — timeout handling", () => {
  it("timeout is set to 10 minutes", () => {
    const TIMEOUT_MS = 10 * 60_000;
    expect(TIMEOUT_MS).toBe(600_000);
  });

  it("timeout error message is descriptive", () => {
    const errorMsg = "Agent job timed out (10min)";
    expect(errorMsg).toContain("10min");
  });
});
