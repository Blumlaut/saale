// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageList } from "@/components/chat/message-list";
import { streamReducer, type StreamAction } from "@/lib/chat/stream-reducer";
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

function shell(id: string, command: string): ToolCallData {
  return {
    id,
    name: "bash",
    args: { command },
    status: "completed",
    result: "ok",
    error: undefined,
  };
}

function fileTool(id: string, name: "read" | "write" | "edit", path: string): ToolCallData {
  return {
    id,
    name,
    args: { path },
    status: "completed",
    result: "ok",
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

function renderTranscript(messages: Message[], compactActivity = true, isLoading = false) {
  return render(
    <MessageList messages={messages} compactActivity={compactActivity} isLoading={isLoading} />,
  );
}

/** The reasoning row's toggle. Its label names the row, never the state. */
function reasoningRow(): HTMLElement {
  return screen.getByRole("button", { name: /Thinking/ });
}

/** Prose bubbles: the rounded cards the markdown goes in. Empty ones are the bug. */
function hollowBubbles(): NodeListOf<Element> {
  return document.querySelectorAll(".liquid-glass-inner.rounded-2xl");
}

/** The card a summary row sits in: rows of one run share it. */
function cardOf(row: HTMLElement): Element | null {
  return row.parentElement?.parentElement ?? null;
}

/** Document order: what a reader meets first. */
function before(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
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

    // One reasoning line and one counter  not a thinking block per step.
    expect(screen.getByText("Thinking")).toBeInTheDocument();
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
          exec("tc-6", "six"),
          exec("tc-7", "seven"),
          exec("tc-8", "eight"),
        ],
      }),
    ]);

    // The counter keeps counting up...
    expect(screen.getByText("Used 8 tools")).toBeInTheDocument();
    // ...over a window of the newest calls, so the row never grows.
    expect(marksOf(toolsRow())).toHaveLength(6);

    // All eight are still reachable.
    fireEvent.click(toolsRow());
    for (const command of ["one", "two", "three", "four", "five", "six", "seven", "eight"]) {
      expect(screen.getByText(command)).toBeInTheDocument();
    }
  });

  it("marks each file tool with its own icon", () => {
    renderTranscript([
      step({
        id: "a1",
        toolCalls: [
          shell("tc-1", "uptime"),
          fileTool("tc-2", "write", "notes.md"),
          fileTool("tc-3", "edit", "notes.md"),
          fileTool("tc-4", "read", "notes.md"),
        ],
      }),
    ]);

    const marks = marksOf(toolsRow()).map(
      (slot) => slot.querySelector("svg")?.getAttribute("class") ?? "",
    );
    // A write, an edit, a read and a shell command are four different things.
    expect(new Set(marks).size).toBe(4);
    expect(marks[0]).toContain("lucide-terminal");
    expect(marks[1]).toContain("lucide-file-plus");
    expect(marks[2]).toContain("lucide-file-pen");
    expect(marks[3]).toContain("lucide-file-text");
  });

  it("wears the same icon in the row as on the card it opens", () => {
    // `bash` has no icon of its own, so the row reads the terminal category's
    // and the card has to read the same one.
    renderTranscript([step({ id: "a1", toolCalls: [shell("tc-1", "uptime")] })]);

    const mark = marksOf(toolsRow())[0]?.querySelector("svg")?.getAttribute("class") ?? "";
    expect(mark).toContain("lucide-terminal");

    fireEvent.click(toolsRow());
    const card = screen.getByText("Bash").closest("button");
    const cardIcons = Array.from(card?.querySelectorAll("svg") ?? []).map(
      (svg) => svg.getAttribute("class") ?? "",
    );
    expect(cardIcons.some((icon) => icon.includes("lucide-terminal"))).toBe(true);
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

  it("keeps a step's reasoning in the card that holds its calls", () => {
    // A step reasons, says its piece ("let me look:"), then calls its tools.
    // Splitting the reasoning away from the calls leaves one card wondering
    // why it is there and the other looking unexplained.
    renderTranscript([
      step({
        id: "a1",
        thinking: "The remote has no credential helper.",
        content: "The remote wants a token:",
        toolCalls: [exec("tc-1", "git push")],
      }),
      step({
        id: "a2",
        thinking: "PR #113 is open.",
        toolCalls: [exec("tc-2", "gh pr checks")],
      }),
    ]);

    const reasoning = screen.getAllByRole("button", { name: /Thinking/ });
    const tools = screen.getAllByRole("button", { name: /Used \d+ tool/ });
    expect(reasoning).toHaveLength(2);
    expect(tools).toHaveLength(2);

    for (const [index, row] of reasoning.entries()) {
      expect(cardOf(row)).toBe(cardOf(tools[index]!));
      expect(before(row, tools[index]!)).toBe(true);
    }

    // The sentence is read after the card that did the work it describes.
    const sentence = screen.getByText("The remote wants a token:");
    expect(before(tools[0]!, sentence)).toBe(true);
    expect(before(sentence, reasoning[1]!)).toBe(true);
  });

  it("starts a new run once a step has spoken", () => {
    renderTranscript([
      step({ id: "a1", content: "Checking both machines:", toolCalls: [exec("tc-1", "uptime")] }),
      step({ id: "a2", toolCalls: [exec("tc-2", "df -h")] }),
    ]);

    const tools = screen.getAllByRole("button", { name: /Used \d+ tool/ });
    expect(tools).toHaveLength(2);
    expect(before(tools[0]!, screen.getByText("Checking both machines:"))).toBe(true);
  });

  it("shows no bubble for a turn that only wrote whitespace", () => {
    // A lone newline between tool rounds is a text block with nothing in it.
    // It used to render as a hollow bubble above the call it preceded.
    renderTranscript([
      step({ id: "a1", content: "\n", toolCalls: [exec("tc-1", "uptime")] }),
      step({ id: "a2", content: "   ", toolCalls: [exec("tc-2", "df -h")] }),
    ]);

    expect(toolsRow()).toBeInTheDocument();
    expect(hollowBubbles()).toHaveLength(0);
  });

  it("shows no empty thinking card either", () => {
    renderTranscript(
      [step({ id: "a1", thinking: " \n ", content: "\n", toolCalls: [exec("tc-1", "uptime")] })],
      false,
    );

    expect(screen.queryByRole("button", { name: /Thought process/ })).toBeNull();
    expect(hollowBubbles()).toHaveLength(0);
    // The call itself is still there, in the step-by-step transcript's own card.
    expect(screen.getByText(/uptime/)).toBeInTheDocument();
  });

  it("keeps one block per kind when a step both reasoned and spoke", () => {
    // A step that reasoned, called a tool AND wrote a sentence produces up to
    // three sibling blocks (activity, prose, files). Keyed by the step id alone
    // they collide: React then omits or duplicates one of them on the next
    // render, so the reasoning block disappeared mid-stream and came back only
    // when a reload remounted the list.
    const keyWarnings: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (text.includes("same key")) keyWarnings.push(text);
    });

    try {
      const reasoned = step({
        id: "a1",
        thinking: "First I looked.",
        toolCalls: [exec("tc-1", "uptime")],
        content: "Nothing is wrong.",
      });
      const { rerender } = renderTranscript([reasoned]);

      // The step streams on: the same blocks re-render with more prose.
      rerender(
        <MessageList
          messages={[{ ...reasoned, content: "Nothing is wrong here either." }]}
          compactActivity
          isLoading
        />,
      );

      expect(keyWarnings).toEqual([]);
      // Both of the step's blocks are still there: the activity row and the prose.
      expect(toolsRow()).toBeInTheDocument();
      expect(screen.getByText("Nothing is wrong here either.")).toBeInTheDocument();
      expect(reasoningRow()).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("shows the newest reasoning and expands to all of it", () => {
    renderTranscript([
      step({ id: "a1", thinking: "First I looked at the logs, which were quiet." }),
      step({ id: "a2", thinking: "Then I checked the queue depth, which was not." }),
    ]);

    const line = screen.getByRole("button", { name: /Thinking/ });
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

  it("leaves the run's status off the row (edge case)", () => {
    renderTranscript([
      step({ id: "a1", toolCalls: [exec("tc-1", "uptime"), exec("tc-2", "df -h", "error")] }),
    ]);

    expect(screen.getByText("Used 2 tools")).toBeInTheDocument();
    expect(screen.queryByText("failed")).not.toBeInTheDocument();
  });

  it("keeps a running call off the row too", () => {
    renderTranscript([step({ id: "a1", toolCalls: [exec("tc-1", "uptime", "running")] })]);

    expect(screen.getByText("Used 1 tool")).toBeInTheDocument();
    expect(screen.queryByText("running")).not.toBeInTheDocument();
  });

  it("spins while the turn is still working", () => {
    const running = [step({ id: "a1", toolCalls: [exec("tc-1", "uptime", "running")] })];
    const { rerender } = renderTranscript(running, true, true);
    expect(toolsRow().querySelector(".animate-spin")).not.toBeNull();

    rerender(<MessageList messages={running} compactActivity isLoading={false} />);
    expect(toolsRow().querySelector(".animate-spin")).toBeNull();
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

  it("holds the transcript's width instead of following the reasoning", () => {
    // The column the summary cards sit in is shrink-to-fit by default, which
    // made it exactly as wide as its widest child: every token of the newest
    // reasoning widened both cards, and the next step's shorter reasoning
    // snapped them back. It claims the line now, so the cards stay put.
    const { rerender } = renderTranscript([
      step({ id: "a1", thinking: "Short.", toolCalls: [exec("tc-1", "uptime")] }),
      step({ id: "a2", content: "Both machines are healthy." }),
    ]);

    const column = reasoningRow().closest("[data-transcript-column]")!;
    expect(column).toHaveClass("flex-1", "min-w-0");

    // The prose bubble hugs its own text rather than filling that width.
    const bubble = screen.getByText("Both machines are healthy.").closest(".liquid-glass-inner")!;
    expect(bubble).toHaveClass("w-fit", "max-w-full");

    // Reasoning that arrives mid-stream changes the text, never the width.
    rerender(
      <MessageList
        messages={[
          step({
            id: "a1",
            thinking: "Short.".concat(" Then a great deal more, streaming in."),
            toolCalls: [exec("tc-1", "uptime")],
          }),
          step({ id: "a2", content: "Both machines are healthy." }),
        ]}
        compactActivity
        isLoading
      />,
    );
    expect(column).toHaveClass("flex-1");
  });

  it("leaves the step-by-step column shrink-to-fit", () => {
    // Off, every step is its own card in a bubble-width column, exactly as before.
    renderTranscript(
      [step({ id: "a1", thinking: "Checked.", content: "Both machines are healthy." })],
      false,
    );

    // Step by step keeps its own wording, and its own bubble-width column.
    const stepByStep = screen.getByRole("button", { name: /Thought process/ });
    const column = stepByStep.closest("[data-transcript-column]")!;
    expect(column).not.toHaveClass("flex-1");
    const bubble = screen.getByText("Both machines are healthy.").closest(".liquid-glass-inner")!;
    expect(bubble).not.toHaveClass("w-fit");
  });

  it("keeps a step's reasoning and calls in one card while it streams", () => {
    // The order the server publishes a step in: reasoning, then its text, then
    // the calls it announced. Rebuilding the transcript per event used to pull
    // the reasoning out of the card its calls landed in, so the two rows were
    // split apart mid-run and merged again by the next step.
    const events: StreamAction[] = [
      { type: "turn_start", turnId: "t1" },
      { type: "thinking", turnId: "t1", thinking: "The dialog never mounts." },
      { type: "token", turnId: "t1", text: "Looking at the render path:" },
      { type: "tool_pending", turnId: "t1", toolCallId: "tc-1", toolName: "bash", args: {} },
      { type: "tool_start", turnId: "t1", toolCallId: "tc-1", toolName: "bash", args: {} },
      { type: "message_saved", turnId: "t1", messageId: "a1" },
    ];

    let state = streamReducer({ messages: [], rootMessageId: null }, events[0]!);
    const { rerender } = renderTranscript(state.messages, true, true);

    for (const event of events.slice(1)) {
      state = streamReducer(state, event);
      rerender(<MessageList messages={state.messages} compactActivity isLoading />);

      const reasoning = screen.getByRole("button", { name: /Thinking/ });
      const tools = screen.queryByRole("button", { name: /Used \d+ tool/ });
      if (tools) expect(cardOf(reasoning)).toBe(cardOf(tools));
    }

    expect(cardOf(reasoningRow())).toBe(cardOf(toolsRow()));
    expect(before(toolsRow(), screen.getByText(/Looking at the render path/))).toBe(true);
  });

  it("reports progress for the whole turn, tools included", () => {
    // The real event sequence, through the real reducer: a step's message is
    // saved (losing its `streaming-` id) before its tool reports back, which is
    // what used to drop the row out of "Thinking" for the length of a call.
    const events: StreamAction[] = [
      { type: "turn_start", turnId: "t1" },
      { type: "thinking", turnId: "t1", thinking: "Looking at the queue depth." },
      { type: "tool_start", turnId: "t1", toolCallId: "tc-1", toolName: "infra_exec", args: {} },
      { type: "message_saved", turnId: "t1", messageId: "a1" },
      { type: "tool_end", turnId: "t1", toolCallId: "tc-1", result: "ok" },
      { type: "turn_start", turnId: "t2" },
    ];

    let state = streamReducer({ messages: [], rootMessageId: null }, events[0]!);
    state = streamReducer(state, events[1]!);
    const { rerender } = renderTranscript(state.messages, true, true);
    expect(reasoningRow()).toHaveTextContent("Thinking");

    for (const event of events.slice(2)) {
      state = streamReducer(state, event);
      rerender(<MessageList messages={state.messages} compactActivity isLoading />);
      expect(reasoningRow()).toHaveTextContent("Thinking");
      expect(reasoningRow().querySelector(".animate-spin")).not.toBeNull();
    }

    // The reply is its own step, so the run settles and the text takes over as
    // the thing that is growing.
    state = streamReducer(state, { type: "token", turnId: "t2", text: "All healthy." });
    rerender(<MessageList messages={state.messages} compactActivity isLoading />);
    expect(reasoningRow()).toHaveTextContent("Thinking");

    // Done: everything is settled, tool cards and all.
    state = streamReducer(state, { type: "generation_done" });
    rerender(<MessageList messages={state.messages} compactActivity isLoading={false} />);
    expect(reasoningRow()).toHaveTextContent("Thinking");
    expect(reasoningRow().querySelector(".animate-spin")).toBeNull();
  });

  it("keeps the same label once the turn has settled", () => {
    // A row that renames itself when it finishes reads as a different row: a
    // transcript of finished turns looked unlike the running one, and the name
    // changed under the reading eye. The spinner is the only thing that moves.
    const settled = [
      step({ id: "a1", thinking: "Checked the box.", toolCalls: [exec("tc-1", "uptime")] }),
    ];
    const { rerender } = renderTranscript(settled, true, true);
    expect(reasoningRow()).toHaveTextContent("Thinking");
    expect(reasoningRow().querySelector(".animate-spin")).not.toBeNull();

    rerender(<MessageList messages={settled} compactActivity isLoading={false} />);
    expect(reasoningRow()).toHaveTextContent("Thinking");
    expect(reasoningRow()).not.toHaveTextContent("Thought process");
    expect(reasoningRow().querySelector(".animate-spin")).toBeNull();
  });

  it("stops reporting once the turn's final reply is coming", () => {
    renderTranscript(
      [
        step({ id: "a1", thinking: "Checked the box.", toolCalls: [exec("tc-1", "uptime")] }),
        step({ id: "a2", content: "Everything is healthy." }),
      ],
      true,
      true,
    );

    // The activity is behind us and the reply is its own block, so the run
    // settles instead of claiming to still be thinking.
    expect(reasoningRow()).toHaveTextContent("Thinking");
    expect(reasoningRow().querySelector(".animate-spin")).toBeNull();
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

  it("reports progress across a tool run when the setting is off too", () => {
    renderTranscript(
      [step({ id: "a1", thinking: "Checking.", toolCalls: [exec("tc-1", "uptime", "running")] })],
      false,
      true,
    );

    expect(reasoningRow()).toHaveTextContent("Thinking");
  });
});

describe("a card opened while the turn streams", () => {
  /** Drive the real reducer through one turn's events, rerendering each time. */
  function streamThrough(events: StreamAction[]) {
    let state = streamReducer({ messages: [], rootMessageId: null }, events[0]!);
    const { rerender } = renderTranscript(state.messages, true, true);
    for (const event of events.slice(1)) {
      state = streamReducer(state, event);
      rerender(<MessageList messages={state.messages} compactActivity isLoading />);
    }
    return { state, rerender };
  }

  it("stays open when its message is saved mid-run", () => {
    const { state, rerender } = streamThrough([
      { type: "turn_start", turnId: "t1" },
      {
        type: "tool_start",
        turnId: "t1",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "uptime" },
      },
    ]);

    fireEvent.click(toolsRow());
    fireEvent.click(screen.getByRole("button", { name: /Bash/ }));
    expect(screen.getByText(/command: uptime/)).toBeInTheDocument();

    // The step's row is written to the DB, so its id stops being `streaming-t1`,
    // while the call it announced is still running.
    const saved = streamReducer(state, { type: "message_saved", turnId: "t1", messageId: "a1" });
    rerender(<MessageList messages={saved.messages} compactActivity isLoading />);

    expect(toolsRow()).toHaveAttribute("aria-expanded", "true");
    const done = streamReducer(saved, {
      type: "tool_end",
      turnId: "t1",
      toolCallId: "tc-1",
      result: "up 3 days",
    });
    rerender(<MessageList messages={done.messages} compactActivity isLoading />);
    expect(screen.getByText(/up 3 days/)).toBeInTheDocument();
  });

  it("stays open in the step-by-step transcript too", () => {
    let state = streamReducer(
      { messages: [], rootMessageId: null },
      {
        type: "turn_start",
        turnId: "t1",
      },
    );
    state = streamReducer(state, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "tc-1",
      toolName: "bash",
      args: { command: "uptime" },
    });
    const { rerender } = renderTranscript(state.messages, false, true);

    const card = () => screen.getByRole("button", { name: /Bash/ });
    fireEvent.click(card());
    expect(screen.getByText(/command: uptime/)).toBeInTheDocument();

    state = streamReducer(state, { type: "message_saved", turnId: "t1", messageId: "a1" });
    rerender(<MessageList messages={state.messages} isLoading />);

    expect(card()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/command: uptime/)).toBeInTheDocument();
  });
});
