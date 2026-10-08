// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ShareViewer } from "@/components/chat/share-viewer";
import type { Message, ToolCallData } from "@/components/chat/types";

/**
 * The public share page shows the same collapsed tool view as the transcript
 * (`CollapsedToolCalls`): a run folds into one summary row, a lone call keeps
 * its own row. The leaves are redacted, so opening a run can only ever reveal
 * the server-written summary — never the args or result behind it.
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

function assistantMessage(toolCalls: ToolCallData[]): Message {
  return {
    id: "a1",
    role: "assistant",
    content: "Working on it.",
    thinking: undefined,
    toolCalls,
    parentMessageId: undefined,
    createdAt: "2026-01-01T12:00:00.000Z",
    attachments: undefined,
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

describe("share viewer tool calls", () => {
  it("folds a turn's several calls into one summary row, one click from the redacted calls", () => {
    renderShare([
      assistantMessage([
        call("t1", "read", "Read a file"),
        call("t2", "bash", "Ran a shell command"),
        call("t3", "web_fetch", "Fetched a web page"),
      ]),
    ]);

    // One row for the run, named by the tools' catalog labels.
    expect(screen.getByText("3 tool calls")).toBeInTheDocument();
    expect(screen.getByText("Read · Bash · Fetch URL")).toBeInTheDocument();
    // The individual summaries are what the row is hiding.
    expect(screen.queryByText("Read a file")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /3 tool calls/ }));
    expect(screen.getByText("Read a file")).toBeInTheDocument();
    expect(screen.getByText("Ran a shell command")).toBeInTheDocument();
    expect(screen.getByText("Fetched a web page")).toBeInTheDocument();
  });

  it("leaves a lone call as its own row, with no summary to open", () => {
    renderShare([assistantMessage([call("t1", "bash", "Ran a shell command")])]);

    expect(screen.queryByText(/tool calls?/)).not.toBeInTheDocument();
    expect(screen.getByText("Ran a shell command")).toBeInTheDocument();
  });

  it("reports a run as failed when one of its calls failed (edge case)", () => {
    renderShare([
      assistantMessage([
        call("t1", "read", "Read a file"),
        call("t2", "bash", "Ran a shell command", { status: "error" }),
      ]),
    ]);

    // The failure is on the collapsed row itself — it is never behind a click.
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("never renders args, results or errors, even once the run is opened (edge case)", () => {
    const { container } = renderShare([
      assistantMessage([
        call("t1", "infra_exec", "Ran a command in the terminal", {
          args: { command: `cat /home/blumlaut/${CANARY}.flac` },
          result: `{"_saaleInfraMeta":{"path":"/lancache/${CANARY}"}}\n${CANARY}`,
          error: `command failed: /home/blumlaut/${CANARY}.flac`,
        }),
        call("t2", "read", "Read a file", { args: { filePath: `/home/blumlaut/${CANARY}.flac` } }),
      ]),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /2 tool calls/ }));

    expect(container.textContent).toContain("Ran a command in the terminal");
    expect(container.textContent).not.toContain(CANARY);
    expect(container.textContent).not.toContain("/home/blumlaut");
  });
});
