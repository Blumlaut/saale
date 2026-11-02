// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextCircle, contextPercent } from "@/components/chat/token-usage-display";
import type { TokenUsage } from "@/components/chat/types";
import type { TurnStats } from "@/lib/pi/turn-stats";

// The popover shell is not what this test is about: render its parts inline so
// the card is in the DOM whether or not it is open.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({
    children,
    ...props
  }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function stats(overrides: Partial<TurnStats> = {}): TurnStats {
  return {
    model: { provider: "anthropic", name: "claude-sonnet-4.5", responseModel: null },
    tokens: { input: 8412, output: 1204, cacheRead: 41200, cacheWrite: 0 },
    cost: 0.0312,
    costFromProvider: true,
    context: {
      tokens: 120000,
      window: 200000,
      parts: { systemPrompt: 12400, tools: 68900, userMessages: 9100, responses: 29600 },
    },
    ...overrides,
  };
}

/**
 * The context ring is the only place a user can see how full the context is
 * (and the entry point to compaction), so its percentage must come from Pi's
 * context accounting  not from summed per-message usage, which excludes
 * prompt-cache reads and reads near-zero for a cached conversation.
 */

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 1_000,
    output: 500,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1_500,
    contextTokens: 32_000,
    contextWindow: 128_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("contextPercent", () => {
  it("computes occupancy from Pi's context tokens", () => {
    expect(contextPercent(usage({ contextTokens: 32_000, contextWindow: 128_000 }))).toBe(25);
    expect(contextPercent(usage({ contextTokens: 64_000, contextWindow: 128_000 }))).toBe(50);
    expect(contextPercent(usage({ contextTokens: 96_000, contextWindow: 128_000 }))).toBe(75);
  });

  it("ignores the summed token totals", () => {
    // A fully cached prompt: `input` is only the newest tokens, the context is
    // nearly full via cacheRead. The old sum-of-input+output reported ~1%.
    const cached = usage({
      input: 120,
      output: 400,
      cacheRead: 100_000,
      cacheWrite: 0,
      total: 100_520,
      contextTokens: 100_000,
      contextWindow: 128_000,
    });
    expect(contextPercent(cached)).toBeCloseTo(78.125, 3);
  });

  it("clamps a context larger than the window to 100%", () => {
    expect(contextPercent(usage({ contextTokens: 130_000, contextWindow: 128_000 }))).toBe(100);
  });

  it("returns null when there is no usable number", () => {
    // Null, no model context window, and no data at all.
    expect(contextPercent(usage({ contextTokens: null }))).toBeNull();
    expect(contextPercent(usage({ contextWindow: 0 }))).toBeNull();
    expect(contextPercent(null)).toBeNull();
  });
});

describe("ContextCircle", () => {
  it("shows the session's stats card, like a message's timestamp does", () => {
    render(
      <ContextCircle
        usage={usage()}
        turns={[
          stats(),
          undefined,
          stats({ cost: 0.02, tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } }),
        ]}
        isCompacting={false}
        onCompact={() => {}}
      />,
    );

    expect(screen.getByTitle("claude-sonnet-4.5")).toBeInTheDocument();
    // Costs and tokens add up over the turns, the context comes from the last one.
    expect(screen.getByText("$0.0512")).toBeInTheDocument();
    expect(screen.getByText("8.4K")).toBeInTheDocument();
    expect(screen.getByText("120K / 200K · 60%")).toBeInTheDocument();
    expect(screen.getByText("2 turns")).toBeInTheDocument();
  });

  it("names the context in the ring before any turn has stats", () => {
    render(<ContextCircle usage={usage()} turns={[]} isCompacting={false} onCompact={() => {}} />);

    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-label",
      "Context 32K/128K (25%)\nIn 1K · Out 500\nClick to compact",
    );
    expect(screen.queryByText("Model")).not.toBeInTheDocument();
  });

  it("fills the ring proportionally to the context usage", () => {
    const { container } = render(
      <ContextCircle
        usage={usage({ contextTokens: 64_000 })}
        isCompacting={false}
        onCompact={() => {}}
      />,
    );

    // A half-full ring: strokeDashoffset is half the circumference.
    const fill = container.querySelectorAll("circle")[1];
    const circumference = Number(fill?.getAttribute("strokeDasharray"));
    const offset = Number(fill?.getAttribute("strokeDashoffset"));
    expect(offset).toBeCloseTo(circumference / 2, 5);
  });

  it("says so when Pi has no context size yet", () => {
    render(
      <ContextCircle
        usage={usage({ contextTokens: null })}
        isCompacting={false}
        onCompact={() => {}}
      />,
    );

    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-label",
      "Context usage unavailable\nIn 1K · Out 500\nClick to compact",
    );
  });

  it("reports missing data before the first response", () => {
    render(<ContextCircle usage={null} turns={[]} isCompacting={false} onCompact={() => {}} />);

    const ring = screen.getByRole("button");
    expect(ring).toHaveAttribute("aria-label", "No usage data yet\nClick to compact");
    const fill = ring.querySelectorAll("circle")[1];
    expect(fill?.getAttribute("strokeDashoffset")).toBe(fill?.getAttribute("strokeDasharray"));
  });

  it("asks for confirmation before compacting", () => {
    const onCompact = vi.fn();
    render(<ContextCircle usage={usage()} isCompacting={false} onCompact={onCompact} />);

    // Clicking must not compact immediately  compaction discards detail.
    fireEvent.click(screen.getByRole("button"));
    expect(onCompact).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it("cannot be clicked while a compaction is running", () => {
    const onCompact = vi.fn();
    render(<ContextCircle usage={usage()} isCompacting onCompact={onCompact} />);

    const ring = screen.getByRole("button");
    expect(ring).toBeDisabled();
    fireEvent.click(ring);
    expect(onCompact).not.toHaveBeenCalled();
    expect(screen.queryByText("Compact conversation?")).not.toBeInTheDocument();
  });
});
