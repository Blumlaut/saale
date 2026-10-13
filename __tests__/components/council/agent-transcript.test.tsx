// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { AgentTranscript } from "@/components/council/agent-transcript";
import type { CouncilMessageView, CouncilTurnView } from "@/types/council";

/**
 * A member's private transcript.
 *
 * The behaviour that matters: it shows the reasoning and every tool call a turn
 * made, it labels what woke the turn with the room messages those seqs point
 * at, and it marks the closing `finalText` as *not sent* — the whole reason the
 * subpage exists is that a member's closing text never reaches the room.
 */

function message(overrides: Partial<CouncilMessageView>): CouncilMessageView {
  return {
    seq: 1,
    memberId: null,
    authorName: "alice",
    authorKind: "member",
    content: "seed",
    addressedNames: [],
    runId: "run-1",
    createdAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

function turn(overrides: Partial<CouncilTurnView>): CouncilTurnView {
  return {
    id: "turn-1",
    runId: "run-1",
    memberId: "member-1",
    memberName: "alice",
    status: "completed",
    thinking: null,
    toolCalls: [],
    finalText: null,
    postedSeqs: [],
    triggeredBy: [],
    seenThrough: null,
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.01,
    error: null,
    startedAt: "2026-01-01T09:00:00.000Z",
    completedAt: "2026-01-01T09:00:05.000Z",
    ...overrides,
  };
}

const ROOM: CouncilMessageView[] = [
  message({ seq: 3, content: "Bob, please check the numbers.", authorName: "alice" }),
  message({ seq: 7, content: "On it.", authorName: "bob" }),
];

describe("AgentTranscript", () => {
  it("renders thinking, tool calls and the not-sent closing text", () => {
    render(
      <AgentTranscript
        messages={ROOM}
        turns={[
          turn({
            thinking: "I should verify the totals before answering.",
            toolCalls: [
              {
                id: "tc-1",
                name: "totally_unknown_tool",
                args: { query: "totals for Q1" },
                result: "42",
                isError: false,
              },
            ],
            finalText: "I would tell the room the totals are wrong, but I am not sure yet.",
          }),
        ]}
      />,
    );

    // Reasoning is shown.
    expect(screen.getByText("I should verify the totals before answering.")).toBeInTheDocument();

    // The tool call is named, and its arguments/result expand on click.
    expect(screen.getByText("totally_unknown_tool")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /totally_unknown_tool/ }));
    expect(screen.getByText("Arguments")).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();

    // The closing text is present and explicitly flagged as unsent.
    expect(
      screen.getByText("I would tell the room the totals are wrong, but I am not sure yet."),
    ).toBeInTheDocument();
    expect(screen.getByText(/NOT sent to the room/i)).toBeInTheDocument();
  });

  it("labels what woke a turn with the room messages the seqs point at", () => {
    render(<AgentTranscript messages={ROOM} turns={[turn({ triggeredBy: [3, 7] })]} />);

    expect(screen.getByText("#3 · alice")).toBeInTheDocument();
    expect(screen.getByText("#7 · bob")).toBeInTheDocument();
    // An excerpt of the message that woke it, so the label is readable.
    expect(screen.getByText(/Bob, please check the numbers/)).toBeInTheDocument();
  });

  it("keeps a seq that is outside the loaded window, rather than dropping it", () => {
    render(<AgentTranscript messages={ROOM} turns={[turn({ triggeredBy: [99] })]} />);

    expect(screen.getByText("#99")).toBeInTheDocument();
  });

  it("shows turns newest first, in the order given", () => {
    render(
      <AgentTranscript
        turns={[
          turn({ id: "new", finalText: "the newer turn", startedAt: "2026-01-01T10:00:00.000Z" }),
          turn({ id: "old", finalText: "the older turn", startedAt: "2026-01-01T09:00:00.000Z" }),
        ]}
      />,
    );

    const headings = screen.getAllByText(/^Turn \d+$/).map((node) => node.textContent);
    expect(headings).toEqual(["Turn 2", "Turn 1"]);
  });

  it("renders an empty state when the member has no turns", () => {
    render(<AgentTranscript turns={[]} />);

    expect(screen.getByText("No turns recorded.")).toBeInTheDocument();
    expect(screen.queryByText(/NOT sent to the room/i)).not.toBeInTheDocument();
  });
});
