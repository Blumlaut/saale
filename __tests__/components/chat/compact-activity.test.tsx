// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageList } from "@/components/chat/message-list";
import type { Message, ToolCallData } from "@/components/chat/types";

/**
 * The condensed transcript (Appearance → "Compact activity").
 *
 * A turn's reasoning and tool calls render as one line each instead of a card
 * per step, which is what stops a long turn from growing without bound. The
 * lines are summaries, never dead ends: everything they fold away is one click
 * down, and the setting off restores the step-by-step transcript byte for byte.
 */

beforeAll(() => {
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = vi.fn();
});

/** A step of a turn: reasoning, work, prose, or any combination. */
function step(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: "assistant",
    content: "",
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: "a0",
    createdAt: "2026-01-01T12:00:00.000Z",
    attachments: undefined,
    ...overrides,
  };
}

function exec(
  id: string,
  command: string,
  status: ToolCallData["status"] = "completed",
): ToolCallData {
  return {
    id,
    name: "infra_exec",
    args: { machineId: "m1", command },
    status,
    result: `ok\n${JSON.stringify({
      _saaleInfraMeta: {
        type: "infra_exec",
        machineId: "m1",
        machineName: "prod-web-01",
        command,
        exitCode: status === "error" ? 1 : 0,
        timedOut: false,
        truncated: false,
        stdout: "ok",
        stderr: "",
      },
    })}`,
    error: status === "error" ? "exit 1" : undefined,
  };
}

function fetch_(id: string, url: string): ToolCallData {
  return {
    id,
    name: "web_fetch",
    args: { url },
    status: "completed",
    result: `Article body\n${JSON.stringify({
      _saaleWebMeta: {
        type: "web_fetch",
        url,
        finalUrl: url,
        title: "An article",
        siteName: null,
        error: false,
      },
    })}`,
    error: undefined,
  };
}

function showFile(id: string, filePath: string): ToolCallData {
  return {
    id,
    name: "show_file",
    args: { filePath },
    status: "completed",
    result: undefined,
    error: undefined,
  };
}

function renderTranscript(messages: Message[], compactActivity = true) {
  return render(<MessageList messages={messages} compactActivity={compactActivity} />);
}

/** The marks in the tool row's sliding window, oldest first. */
function marksOf(toolsButton: HTMLElement): HTMLElement[] {
  // Spans only: lucide marks the row's chevron `aria-hidden` too.
  const strip = toolsButton.querySelector('span[aria-hidden="true"]');
  return Array.from(strip?.querySelectorAll<HTMLElement>(":scope > span") ?? []);
}

/** The tool row's header toggle. */
function toolsRow(): HTMLElement {
  return screen.getByRole("button", { name: /Used \d+ tool/ });
}

describe("compact activity", () => {
  it("condenses a turn's reasoning and work to one line each", () => {
    renderTranscript([
      step({
        id: "a1",
        thinking: "The search yielded three candidate pages, so I checked each one.",
        toolCalls: [exec("tc-1", "uptime"), exec("tc-2", "df -h")],
      }),
      step({ id: "a2", content: "Both machines are healthy." }),
    ]);

    // One reasoning line and one counter — not a thinking block per step.
    expect(screen.getByText("Thought process:")).toBeInTheDocument();
    expect(screen.getByText(/The search yielded three candidate pages/)).toBeInTheDocument();
    expect(screen.getByText("Used 2 tools")).toBeInTheDocument();

    // The work itself is behind the counter, and the prose is untouched.
    expect(screen.queryByText("uptime")).not.toBeInTheDocument();
    expect(screen.getByText("Both machines are healthy.")).toBeInTheDocument();

    fireEvent.click(toolsRow());
    expect(screen.getByText("uptime")).toBeInTheDocument();
    expect(screen.getByText("df -h")).toBeInTheDocument();
  });

  it("counts every call while showing only the newest marks", () => {
    renderTranscript([
      step({
        id: "a1",
        toolCalls: [
          exec("tc-1", "one"),
          exec("tc-2", "two"),
          exec("tc-3", "three"),
          exec("tc-4", "four"),
          exec("tc-5", "five"),
        ],
      }),
    ]);

    // The counter keeps counting up...
    expect(screen.getByText("Used 5 tools")).toBeInTheDocument();
    // ...over a window of the newest calls, so the row never grows.
    expect(marksOf(toolsRow())).toHaveLength(3);

    // All five are still reachable.
    fireEvent.click(toolsRow());
    for (const command of ["one", "two", "three", "four", "five"]) {
      expect(screen.getByText(command)).toBeInTheDocument();
    }
  });

  it("keeps one run across steps and splits it at prose", () => {
    renderTranscript([
      step({ id: "a1", thinking: "First I looked.", toolCalls: [exec("tc-1", "uptime")] }),
      step({ id: "a2", toolCalls: [exec("tc-2", "df -h")] }),
      step({ id: "a3", content: "That much is clear." }),
      step({ id: "a4", thinking: "Then I dug deeper.", toolCalls: [exec("tc-3", "free -m")] }),
    ]);

    // The two steps before the prose are one run; the step after it is another.
    expect(screen.getByText("Used 2 tools")).toBeInTheDocument();
    expect(screen.getByText("Used 1 tool")).toBeInTheDocument();
    expect(screen.getByText("That much is clear.")).toBeInTheDocument();
  });

  it("shows the newest reasoning and expands to all of it", () => {
    renderTranscript([
      step({ id: "a1", thinking: "First I looked at the logs, which were quiet." }),
      step({ id: "a2", thinking: "Then I checked the queue depth, which was not." }),
    ]);

    const line = screen.getByRole("button", { name: /Thought process/ });
    expect(line).toHaveTextContent("Then I checked the queue depth");
    expect(line).not.toHaveTextContent("First I looked at the logs");

    fireEvent.click(line);
    const full = screen.getByText(/First I looked at the logs/);
    expect(full).toHaveTextContent("Then I checked the queue depth");
  });

  it("marks a fetched page with the site's own favicon", () => {
    renderTranscript([
      step({
        id: "a1",
        toolCalls: [fetch_("tc-1", "https://blog.example.com/post"), exec("tc-2", "uptime")],
      }),
    ]);

    const images = marksOf(toolsRow()).map((slot) => slot.querySelector("img"));
    expect(images[0]).toHaveAttribute(
      "src",
      "https://www.google.com/s2/favicons?domain=blog.example.com&sz=32",
    );
    // A call that opened no page keeps its tool icon.
    expect(images[1]).toBeNull();
  });

  it("reports a run as failed when one of its calls failed", () => {
    renderTranscript([
      step({ id: "a1", toolCalls: [exec("tc-1", "uptime"), exec("tc-2", "df -h", "error")] }),
    ]);

    expect(screen.getByText("failed")).toHaveClass("text-red-600");
  });

  it("still shows a running call as running", () => {
    renderTranscript([step({ id: "a1", toolCalls: [exec("tc-1", "uptime", "running")] })]);

    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("keeps a shown file open while the work beside it stays folded", () => {
    renderTranscript([
      step({
        id: "a1",
        toolCalls: [exec("tc-1", "uptime"), showFile("tc-2", "reports/quarterly.pdf")],
      }),
    ]);

    expect(screen.getByText("Used 1 tool")).toBeInTheDocument();
    expect(screen.getByText("quarterly.pdf")).toBeInTheDocument();
  });

  it("leaves the step-by-step transcript alone when the setting is off", () => {
    renderTranscript(
      [
        step({
          id: "a1",
          thinking: "The search yielded three candidate pages.",
          toolCalls: [exec("tc-1", "uptime"), exec("tc-2", "df -h")],
        }),
      ],
      false,
    );

    expect(screen.queryByText(/^Used /)).not.toBeInTheDocument();
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
    expect(screen.getByText("Thought process")).toBeInTheDocument();
  });
});
