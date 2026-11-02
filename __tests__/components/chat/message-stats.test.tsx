// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The popover shell is not what this test is about: render its parts inline so
// the card is in the DOM whether or not it is open.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
  }) => <button {...props}>{children}</button>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { MessageStats } from "@/components/chat/message-stats";
import type { TurnStats } from "@/lib/pi/turn-stats";

/**
 * The card is the only place a turn's cost is shown, and it has to hold up for
 * a message saved before stats existed, for a group of turns, and for a price
 * that is an estimate rather than a bill.
 */

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

const CREATED_AT = "2026-11-02T14:32:00.000Z";

describe("MessageStats", () => {
  it("shows the plain time for a message that has no stats", () => {
    render(<MessageStats turns={[undefined]} createdAt={CREATED_AT} />);

    expect(screen.queryByText("Context")).not.toBeInTheDocument();
    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument();
  });

  it("shows the model, the tokens, the cost and the context split", () => {
    render(<MessageStats turns={[stats()]} createdAt={CREATED_AT} />);

    expect(screen.getByTitle("claude-sonnet-4.5")).toBeInTheDocument();
    expect(screen.getByText("8.4K")).toBeInTheDocument();
    expect(screen.getByText("41.2K")).toBeInTheDocument();
    expect(screen.getByText("$0.0312")).toBeInTheDocument();
    expect(screen.getByText("120K / 200K · 60%")).toBeInTheDocument();
    expect(screen.getByText("System prompt")).toBeInTheDocument();
    expect(screen.getByText("68.9K")).toBeInTheDocument();
    expect(screen.getByText("billed")).toBeInTheDocument();
    expect(screen.getByText("1 turn")).toBeInTheDocument();
  });

  it("names the model that was asked for, not the one the router answered with", () => {
    render(
      <MessageStats
        turns={[
          stats({
            model: {
              provider: "custom-some-provider",
              name: "qwen3.5-9b-instruct",
              responseModel: "unsloth/Qwen3.5-9B-GGUF:UD-Q6_K_XL",
            },
          }),
        ]}
        createdAt={CREATED_AT}
      />,
    );

    expect(screen.getByTitle("qwen3.5-9b-instruct")).toBeInTheDocument();
    expect(screen.queryByText(/unsloth/)).not.toBeInTheDocument();
  });

  it("leaves the cached count out when the provider reports no prompt cache", () => {
    render(
      <MessageStats
        turns={[stats({ tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } })]}
        createdAt={CREATED_AT}
      />,
    );

    expect(screen.queryByText("cached")).not.toBeInTheDocument();
  });

  it("shows the tokens used when the model declares no context window", () => {
    render(
      <MessageStats
        turns={[
          stats({
            context: {
              tokens: 7308,
              window: 0,
              parts: { systemPrompt: 7067, tools: 0, userMessages: 59, responses: 182 },
            },
          }),
        ]}
        createdAt={CREATED_AT}
      />,
    );

    expect(screen.getByText("7.3K used")).toBeInTheDocument();
  });

  it("keeps the rows as the hover targets and drops the explainer", () => {
    render(<MessageStats turns={[stats()]} createdAt={CREATED_AT} />);

    const row = screen.getByRole("button", { name: /Tools/ });
    fireEvent.mouseEnter(row);
    expect(row).toHaveClass("bg-accent");

    fireEvent.mouseLeave(row);
    expect(row).not.toHaveClass("bg-accent");
    expect(screen.queryByText(/What the tools returned/)).not.toBeInTheDocument();
  });

  it("adds a group's turns up and counts them", () => {
    render(
      <MessageStats
        turns={[
          stats({ cost: 0.01, tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } }),
          stats({ cost: 0.02 }),
        ]}
        createdAt={CREATED_AT}
      />,
    );

    expect(screen.getByText("$0.0300")).toBeInTheDocument();
    expect(screen.getByText("2 turns")).toBeInTheDocument();
    expect(screen.getByText("8.4K")).toBeInTheDocument();
  });

  it("calls a mixed or estimated price estimated", () => {
    render(<MessageStats turns={[stats({ costFromProvider: false })]} createdAt={CREATED_AT} />);

    expect(screen.getByText("estimated")).toBeInTheDocument();
    expect(screen.queryByText("billed")).not.toBeInTheDocument();
  });

  it("says unknown instead of inventing a context total", () => {
    render(
      <MessageStats
        turns={[
          stats({
            context: {
              tokens: null,
              window: 200000,
              parts: { systemPrompt: 0, tools: 0, userMessages: 0, responses: 0 },
            },
          }),
        ]}
        createdAt={CREATED_AT}
      />,
    );

    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.getAllByText("0%")).toHaveLength(4);
  });
});
