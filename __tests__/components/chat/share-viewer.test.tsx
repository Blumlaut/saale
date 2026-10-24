// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShareViewer } from "@/components/chat/share-viewer";
import type { Message, ToolCallData } from "@/components/chat/types";

/**
 * The public share page renders the same condensed transcript the owner gets
 * with "Compact activity" on: a turn's steps fold into one "Used N tools" row,
 * and prose ends the run. The leaves are redacted, so opening a run can only
 * ever reveal the server-written summary  never the args or result behind it.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeAll(() => {
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = vi.fn();
});

/** A canary a leak would have to carry out through args, result or error. */
const CANARY = "9f3a2b7c-quarantine";

function call(
  id: string,
  name: string,
  redacted: string,
  extra: Partial<ToolCallData> = {},
): ToolCallData {
  return {
    id,
    name,
    redacted,
    args: {},
    status: "completed",
    result: undefined,
    error: undefined,
    ...extra,
  };
}

/** One step of a turn  a child of the group's root step unless it is the root. */
function step(id: string, toolCalls: ToolCallData[], extra: Partial<Message> = {}): Message {
  return {
    id,
    role: "assistant",
    content: "",
    thinking: undefined,
    toolCalls,
    parentMessageId: id === "a1" ? undefined : "a1",
    createdAt: "2026-01-01T12:00:00.000Z",
    attachments: undefined,
    ...extra,
  };
}

function renderShare(messages: Message[]) {
  return render(
    <ShareViewer
      token="tok"
      sessionTitle="Shared run"
      messages={messages}
      isAuthenticated={false}
    />,
  );
}

/** The activity row's toggle  the count reports the whole run. */
function toolsRow(): HTMLElement {
  return screen.getByRole("button", { name: /Used \d+ tool/ });
}

/** The marks in the activity row's sliding window, oldest first. */
function marksOf(toolsButton: HTMLElement): HTMLElement[] {
  // Spans only: lucide marks the row's chevron `aria-hidden` too.
  const strip = toolsButton.querySelector('span[aria-hidden="true"]');
  return Array.from(strip?.querySelectorAll<HTMLElement>(":scope > span") ?? []);
}

describe("share viewer tool calls", () => {
  it("folds a turn's run of steps into one compact activity row", () => {
    renderShare([
      step("a1", [call("t1", "read", "Read a file"), call("t2", "bash", "Ran a shell command")]),
      step("a2", [call("t3", "web_fetch", "Fetched a web page")]),
    ]);

    // One row for the whole run  not one collapsed row per step.
    expect(screen.getByText("Used 3 tools")).toBeInTheDocument();
    expect(screen.queryByText(/tool calls?/)).not.toBeInTheDocument();

    // The individual summaries are what the row is hiding.
    expect(screen.queryByText("Read a file")).not.toBeInTheDocument();

    fireEvent.click(toolsRow());
    expect(screen.getByText("Read a file")).toBeInTheDocument();
    expect(screen.getByText("Ran a shell command")).toBeInTheDocument();
    expect(screen.getByText("Fetched a web page")).toBeInTheDocument();
  });

  it("counts every call while showing only the newest marks", () => {
    const calls = Array.from({ length: 8 }, (_, index) =>
      call(`t${index + 1}`, "read", "Read a file"),
    );
    renderShare([step("a1", calls)]);

    // The counter keeps counting up, over a window of the newest calls.
    expect(screen.getByText("Used 8 tools")).toBeInTheDocument();
    expect(marksOf(toolsRow())).toHaveLength(6);

    // All eight are still reachable.
    fireEvent.click(toolsRow());
    expect(screen.getAllByText("Read a file")).toHaveLength(8);
  });

  it("splits the run at prose, so a sentence reads where it was said", () => {
    renderShare([
      step("a1", [call("t1", "read", "Read a file")]),
      step("a2", [], { content: "That much is clear." }),
      step("a3", [call("t2", "bash", "Ran a shell command")]),
    ]);

    // Two runs, one either side of the sentence.
    expect(screen.getAllByText("Used 1 tool")).toHaveLength(2);
    expect(screen.getByText("That much is clear.")).toBeInTheDocument();
  });

  it("leaves a lone call's run as a single row", () => {
    renderShare([step("a1", [call("t1", "bash", "Ran a shell command")])]);

    expect(screen.getByText("Used 1 tool")).toBeInTheDocument();
    expect(screen.queryByText(/tool calls?/)).not.toBeInTheDocument();
  });

  it("reports a run as failed when one of its calls failed (edge case)", () => {
    renderShare([
      step("a1", [
        call("t1", "read", "Read a file"),
        call("t2", "bash", "Ran a shell command", { status: "error" }),
      ]),
    ]);

    // The failure is on the activity row itself  it is never behind a click.
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("never renders args, results or errors, even once the run is opened (edge case)", () => {
    const { container } = renderShare([
      step("a1", [
        call("t1", "infra_exec", "Ran a command in the terminal", {
          args: { command: `cat /home/blumlaut/${CANARY}.flac` },
          result: `{"_saaleInfraMeta":{"path":"/lancache/${CANARY}"}}\n${CANARY}`,
          error: `command failed: /home/blumlaut/${CANARY}.flac`,
        }),
        call("t2", "read", "Read a file", { args: { filePath: `/home/blumlaut/${CANARY}.flac` } }),
      ]),
    ]);

    fireEvent.click(toolsRow());

    expect(container.textContent).toContain("Ran a command in the terminal");
    expect(container.textContent).not.toContain(CANARY);
    expect(container.textContent).not.toContain("/home/blumlaut");
  });
});
