// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToolCallView } from "@/components/chat/tool-call-view";
import { MessageList } from "@/components/chat/message-list";
import { ALL_TOOL_INFOS } from "@/lib/pi/tool-infos";
import type { Message, ToolCallData } from "@/components/chat/types";

/**
 * The card shell, through the dispatcher.
 *
 * Every card is described by a descriptor (see `tool-descriptors.test.ts` for
 * what each one says), so these tests cover what only the renderer can get
 * wrong: collapsing, the single status badge, the fallback when a descriptor
 * cannot read a result, and the hand-off to the redacted card on a share
 * payload.
 */

beforeAll(() => {
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = vi.fn();
});

function makeToolCall(overrides: Partial<ToolCallData>): ToolCallData {
  return {
    id: "tc-1",
    name: "unknown",
    args: {},
    status: "completed",
    result: undefined,
    error: undefined,
    ...overrides,
  };
}

function infraMeta(meta: Record<string, unknown>): string {
  return `done\n${JSON.stringify({ _saaleInfraMeta: meta })}`;
}

/** The card's header toggle — the only button a collapsed card renders. */
function header(name: RegExp) {
  return screen.getByRole("button", { name });
}

describe("tool card shell", () => {
  it("keeps a card's detail collapsed until the header is clicked", () => {
    render(
      <ToolCallView
        toolCall={makeToolCall({ name: "bash", args: { command: "ls -la" }, result: "total 0" })}
      />,
    );

    // One row: the label from the catalog and the command it ran.
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();

    fireEvent.click(header(/Bash/));
    expect(screen.getByText("Arguments")).toBeInTheDocument();
    expect(screen.getByText("total 0")).toBeInTheDocument();

    fireEvent.click(header(/Bash/));
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();
  });

  it("renders a card with nothing to expand as a plain row", () => {
    render(
      <ToolCallView
        toolCall={makeToolCall({
          name: "infra_remove_machine",
          result: infraMeta({
            type: "infra_remove_machine",
            machineId: "m1",
            machineName: "prod-web-01",
          }),
        })}
      />,
    );

    expect(screen.getByText("Removed machine")).toBeInTheDocument();
    expect(screen.getByText("removed")).toBeInTheDocument();
    // Nothing to open, so no expander and no focusable control.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("opens a result-shaped card straight away, since its rows are the answer", () => {
    const meta = {
      _saaleMailMeta: {
        type: "mail_list",
        count: 1,
        total: 5,
        emails: [
          {
            id: "e1",
            from: "Alice <alice@example.com>",
            subject: "Project update",
            date: "2026-01-01T10:00:00.000Z",
            preview: "Quick update about the roadmap",
            read: false,
            folder: "Inbox",
          },
        ],
      },
    };

    render(
      <ToolCallView toolCall={makeToolCall({ name: "mail_list", result: JSON.stringify(meta) })} />,
    );

    expect(screen.getByText("Project update")).toBeInTheDocument();
    expect(screen.getByText("1 email")).toBeInTheDocument();
  });

  it("reports a command's exit code, and shows its output only once opened", () => {
    render(
      <ToolCallView
        toolCall={makeToolCall({
          name: "infra_exec",
          result: infraMeta({
            type: "infra_exec",
            machineId: "m1",
            machineName: "prod-web-01",
            command: "nginx -t",
            exitCode: 0,
            timedOut: false,
            truncated: false,
            stdout: "configuration file test is successful",
            stderr: "",
          }),
        })}
      />,
    );

    expect(screen.getByText("Executed")).toBeInTheDocument();
    expect(screen.getByText("nginx -t")).toBeInTheDocument();
    expect(screen.getByText("exit 0")).toHaveClass("text-green-600");
    expect(screen.queryByText("prod-web-01")).not.toBeInTheDocument();

    fireEvent.click(header(/Executed/));
    expect(screen.getByText("prod-web-01")).toBeInTheDocument();
    expect(screen.getByText("configuration file test is successful")).toBeInTheDocument();
  });

  it("opens a failed command, so its error is not behind a click", () => {
    render(
      <ToolCallView
        toolCall={makeToolCall({
          name: "infra_exec",
          result: infraMeta({
            type: "infra_exec",
            machineId: "m1",
            machineName: "prod-web-01",
            command: "systemctl restart reencode@blade-runner.service",
            exitCode: 1,
            timedOut: false,
            truncated: false,
            stdout: "",
            stderr: "Job for reencode@blade-runner.service failed",
          }),
        })}
      />,
    );

    expect(screen.getByText("exit 1")).toHaveClass("text-red-600");
    expect(screen.getByText("Job for reencode@blade-runner.service failed")).toBeInTheDocument();
  });

  it("summarises a long diff instead of rendering every line", () => {
    const diffLines = Array.from({ length: 45 }, (_, i) => `+${i + 1} line ${i + 1}`);
    const meta = {
      _saaleInfraMeta: {
        type: "infra_edit_file",
        machineId: "m1",
        machineName: "prod-web-01",
        path: "/etc/nginx/nginx.conf",
        replacements: 2,
        firstChangedLine: 2,
        diff: `-2 listen 80;\n+2 listen 8080;\n${diffLines.join("\n")}`,
      },
    };

    render(
      <ToolCallView
        toolCall={makeToolCall({ name: "infra_edit_file", result: JSON.stringify(meta) })}
      />,
    );
    fireEvent.click(header(/Edited file/));

    expect(screen.getByText("Edited file")).toBeInTheDocument();
    expect(screen.getByText("/etc/nginx/nginx.conf")).toBeInTheDocument();
    expect(screen.getByText("2 edits")).toBeInTheDocument();
    expect(screen.getByText("prod-web-01")).toBeInTheDocument();
    expect(screen.getByText("line 2")).toBeInTheDocument();
    expect(screen.getByText("-2 listen 80;")).toHaveClass("text-red-700");
    expect(screen.getByText("+2 listen 8080;")).toHaveClass("text-green-700");

    // 45 diff lines plus the two leading ones, capped at 40 shown.
    expect(screen.getByText("+38 line 38")).toBeInTheDocument();
    expect(screen.queryByText("+39 line 39")).not.toBeInTheDocument();
    expect(screen.getByText("7 more lines")).toBeInTheDocument();
  });

  it("flags a truncated remote read and claims no line count for it", () => {
    const meta = {
      _saaleInfraMeta: {
        type: "infra_read_file",
        machineId: "m1",
        machineName: "prod-web-01",
        path: "/var/log/huge.log",
        truncated: true,
        totalLines: 9800,
        preview: "2025-01-01 boot: started",
      },
    };

    render(
      <ToolCallView
        toolCall={makeToolCall({ name: "infra_read_file", result: JSON.stringify(meta) })}
      />,
    );
    fireEvent.click(header(/Read file/));

    expect(screen.getByText("truncated")).toBeInTheDocument();
    expect(screen.getByText(/2025-01-01 boot/)).toBeInTheDocument();
    expect(screen.queryByText("9800 lines")).not.toBeInTheDocument();
  });

  it("labels a remote image read and shows no text preview", () => {
    const meta = {
      _saaleInfraMeta: {
        type: "infra_read_file",
        machineId: "m1",
        machineName: "prod-web-01",
        path: "/var/www/logo.png",
        truncated: false,
        preview: "Read image file [image/png]",
        imageMimeType: "image/png",
      },
    };

    render(
      <ToolCallView
        toolCall={makeToolCall({ name: "infra_read_file", result: JSON.stringify(meta) })}
      />,
    );

    expect(screen.getByText("Read image")).toBeInTheDocument();
    expect(screen.queryByText(/Read image file/)).not.toBeInTheDocument();
  });

  it("hands a result it cannot read to the generic card rather than hiding the call", () => {
    render(
      <ToolCallView
        toolCall={makeToolCall({
          name: "web_search",
          result: 'Search results for "query" (0 results):\n\nNo results found.',
        })}
      />,
    );

    // The catalog label, not the raw tool name, and the raw result on demand.
    expect(screen.getByText("Web Search")).toBeInTheDocument();
    expect(screen.queryByText("Searched")).not.toBeInTheDocument();

    fireEvent.click(header(/Web Search/));
    expect(screen.getByText(/No results found/)).toBeInTheDocument();
  });

  it("renders multi-line argument values with real newlines", () => {
    // JSON.stringify escapes newlines, so a naive render shows a literal
    // backslash-n for every multi-line command or script.
    const { container } = render(
      <ToolCallView
        toolCall={makeToolCall({
          name: "custom_tool",
          args: { command: "git fetch\n  && git status" },
        })}
      />,
    );

    fireEvent.click(header(/custom_tool/));
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("command: git fetch\n  && git status");
    expect(pre?.textContent).not.toContain("\\n");
  });

  it("renders a codemode script with the tools it calls (reloaded transcript)", () => {
    // Only the codemode call is in the assistant message, so after a reload the
    // card has to tell the user what the script reached from the script itself.
    const code =
      "const mails = await tools.mail_list({ folder: 'INBOX' });\nconst web = await tools.web_search({ query: 'x' });\nreturn [mails, web];";

    render(
      <ToolCallView
        toolCall={makeToolCall({
          name: "codemode",
          args: { code },
          result: "Script completed\n2 emails",
        })}
      />,
    );

    // Distinct label from the raw tool name — the header says what it is.
    expect(screen.getByText("Script")).toBeInTheDocument();
    expect(screen.getByText("List Emails · Web Search")).toBeInTheDocument();
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();

    fireEvent.click(header(/Script/));
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText(/2 emails/)).toBeInTheDocument();
  });

  it("renders a FileCard for show_file with args extracted from the call", () => {
    render(
      <ToolCallView
        toolCall={makeToolCall({
          name: "show_file",
          args: { filePath: "reports/summary.txt", description: "Quarterly report" },
        })}
      />,
    );

    expect(screen.getByText("summary.txt")).toBeInTheDocument();
    expect(screen.getByText("Quarterly report")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
  });
});

describe("parallel tool calls", () => {
  function message(calls: ToolCallData[]): Message {
    return {
      id: "a1",
      role: "assistant",
      content: "Checking both machines.",
      thinking: undefined,
      toolCalls: calls,
      parentMessageId: undefined,
      createdAt: "2026-01-01T12:00:00.000Z",
      attachments: undefined,
    };
  }

  const exec = (id: string, command: string) =>
    makeToolCall({
      id,
      name: "infra_exec",
      result: infraMeta({
        type: "infra_exec",
        machineId: "m1",
        machineName: "prod-web-01",
        command,
        exitCode: 0,
        timedOut: false,
        truncated: false,
        stdout: "ok",
        stderr: "",
      }),
    });

  it("collapses the calls one turn made into a single row", () => {
    render(<MessageList messages={[message([exec("tc-1", "uptime"), exec("tc-2", "df -h")])]} />);

    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
    // Neither command is taking up a row of its own.
    expect(screen.queryByText("uptime")).not.toBeInTheDocument();

    fireEvent.click(header(/2 tool calls/));
    expect(screen.getByText("uptime")).toBeInTheDocument();
    expect(screen.getByText("df -h")).toBeInTheDocument();
  });

  it("reports the run as failed when one of its calls failed", () => {
    const failed = { ...exec("tc-2", "df -h"), status: "error" as const, error: "exit 1" };
    render(<MessageList messages={[message([exec("tc-1", "uptime"), failed])]} />);

    expect(screen.getByText("failed")).toHaveClass("text-red-600");
  });

  it("leaves a lone tool call as its own card", () => {
    render(<MessageList messages={[message([exec("tc-1", "uptime")])]} />);

    expect(screen.queryByText("1 tool call")).not.toBeInTheDocument();
    expect(screen.getByText("uptime")).toBeInTheDocument();
  });
});

/**
 * `show_file` is not a report of a call — it is the file the agent handed the
 * user. It therefore never folds into a run: one file is its own card, several
 * are a gallery, and both are open from the first render.
 */
describe("files the agent showed the user", () => {
  function message(calls: ToolCallData[]): Message {
    return {
      id: "a1",
      role: "assistant",
      content: "Here are the plots.",
      thinking: undefined,
      toolCalls: calls,
      parentMessageId: undefined,
      createdAt: "2026-01-01T12:00:00.000Z",
      attachments: undefined,
    };
  }

  const exec = (id: string, command: string) =>
    makeToolCall({
      id,
      name: "infra_exec",
      result: infraMeta({
        type: "infra_exec",
        machineId: "m1",
        machineName: "prod-web-01",
        command,
        exitCode: 0,
        timedOut: false,
        truncated: false,
        stdout: "ok",
        stderr: "",
      }),
    });

  const image = (id: string) =>
    makeToolCall({
      id,
      name: "show_file",
      args: { filePath: `plots/${id}.png`, description: `Plot ${id}` },
    });

  const doc = (id: string) =>
    makeToolCall({ id, name: "show_file", args: { filePath: `reports/${id}.pdf` } });

  beforeEach(() => {
    // jsdom has no object URLs, and no endpoint to serve the file bytes.
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:preview"),
      writable: true,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["bytes"]) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the files open while the work beside them stays collapsed", () => {
    render(
      <MessageList
        messages={[message([exec("tc-1", "uptime"), exec("tc-2", "df -h"), image("chart")])]}
      />,
    );

    // The work is still a summary row...
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
    expect(screen.queryByText("uptime")).not.toBeInTheDocument();

    // ...but the file was never behind a click.
    expect(screen.getByText("chart.png")).toBeInTheDocument();
    expect(screen.getByText("Plot chart")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download chart.png" })).toBeInTheDocument();
  });

  it("shows a lone shared file without a summary row of its own", () => {
    render(<MessageList messages={[message([exec("tc-1", "uptime"), doc("quarterly")])]} />);

    expect(screen.queryByText(/tool calls?/)).not.toBeInTheDocument();
    expect(screen.getByText("uptime")).toBeInTheDocument();
    expect(screen.getByText("quarterly.pdf")).toBeInTheDocument();
  });

  it("lays several shared images out as a thumbnail gallery", async () => {
    render(<MessageList messages={[message([image("alpha"), image("beta"), doc("notes")])]} />);

    // No work to summarise, so the turn is nothing but the files.
    expect(screen.queryByText(/tool calls?/)).not.toBeInTheDocument();

    // Both images render a preview once their bytes arrive, one thumbnail each.
    await act(async () => {});
    expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(2);
    expect(screen.getByText("notes.pdf")).toBeInTheDocument();
  });

  it("opens a shared image in the lightbox", async () => {
    render(<MessageList messages={[message([image("alpha"), image("beta")])]} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "View alpha.png" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows the reason a file that failed could not be shared (edge case)", () => {
    const missing = {
      ...image("missing"),
      status: "error" as const,
      error: "File not found: plots/missing.png",
    };

    render(<MessageList messages={[message([doc("quarterly"), missing])]} />);

    expect(screen.getByText("quarterly.pdf")).toBeInTheDocument();
    expect(screen.getByText("missing.png")).toBeInTheDocument();
    expect(screen.getByText("File not found: plots/missing.png")).toBeInTheDocument();
  });
});

/**
 * A redacted payload is what the share endpoints serve. Its args and result
 * were stripped server-side, so the diversion to `RedactedToolCall` is the only
 * thing standing between a public page and a card built for the owner's data.
 */
describe("ToolCallView with a redacted tool call", () => {
  it("shows the tool label and the server-written summary, not the raw card", () => {
    render(
      <ToolCallView
        toolCall={makeToolCall({
          name: "infra_exec",
          status: "error",
          redacted: "Ran a command in the terminal",
        })}
      />,
    );

    expect(screen.getByText("Execute Command")).toBeInTheDocument();
    expect(screen.getByText("Ran a command in the terminal")).toBeInTheDocument();
    // The owner's exec card header — proof the diversion happened.
    expect(screen.queryByText("Executed")).not.toBeInTheDocument();
  });

  it("falls back to the raw tool name when the tool is not in the catalog", () => {
    render(
      <ToolCallView
        toolCall={makeToolCall({ name: "some_future_tool", redacted: "Ran a tool" })}
      />,
    );

    expect(screen.getByText("some_future_tool")).toBeInTheDocument();
    expect(screen.getByText("Ran a tool")).toBeInTheDocument();
  });

  it("never reaches a dedicated card, even with args and a result present (edge case)", () => {
    // Defence in depth: if redaction ever regressed and left data on the call,
    // the dedicated card must still not be the one that renders.
    render(
      <ToolCallView
        toolCall={makeToolCall({
          name: "show_file",
          args: { filePath: "/legoshiba/cloud/music/Wolfgun/secret.flac", description: "Backup" },
          result: "ok",
          redacted: "Shared a file",
        })}
      />,
    );

    expect(screen.getByText("Shared a file")).toBeInTheDocument();
    expect(screen.queryByText(/secret\.flac/)).not.toBeInTheDocument();
    expect(screen.queryByText("Backup")).not.toBeInTheDocument();
  });
});

/**
 * The render half of the guard.
 *
 * Driven by `ALL_TOOL_INFOS`, so a tool added to the catalog — and the card
 * that goes with it — is covered as soon as it lands. The payload carries the
 * poisoned args and result a leak would have to come from, plus the `redacted`
 * field the share endpoints set.
 */
describe("redacted rendering across the tool catalog", () => {
  const CANARY = "9f3a2b7c-quarantine";

  function poisonedCall(name: string): ToolCallData {
    return makeToolCall({
      name,
      status: "error",
      args: {
        filePath: `/home/blumlaut/${CANARY}.flac`,
        command: `curl -H "Authorization: ${CANARY}" https://cloud-prod-environment/`,
      },
      result:
        `ffprobe output\n{"_saaleInfraMeta":{"type":"infra_exec",` +
        `"machineName":"cloud-prod-environment","path":"/lancache/${CANARY}"}}\n${CANARY}`,
      error: `command failed: /home/blumlaut/${CANARY}.flac`,
      redacted: `summary for ${name}`,
    });
  }

  it("shows the summary and nothing else for every tool in the catalog", () => {
    for (const { name } of ALL_TOOL_INFOS) {
      const { container, unmount } = render(<ToolCallView toolCall={poisonedCall(name)} />);

      expect(container.textContent, name).toContain(`summary for ${name}`);
      expect(container.textContent, name).not.toContain(CANARY);
      expect(container.textContent, name).not.toContain("cloud-prod-environment");
      expect(container.textContent, name).not.toContain("/lancache");
      expect(container.textContent, name).not.toContain("/home/blumlaut");

      // Inert: nothing to expand, download or fetch for a public reader.
      expect(container.querySelectorAll("button"), name).toHaveLength(0);
      expect(container.querySelectorAll("a"), name).toHaveLength(0);

      unmount();
    }
  });

  it("renders the redacted card without an accordion to open (edge case)", () => {
    const { container } = render(<ToolCallView toolCall={poisonedCall("bash")} />);

    // The generic card for an unknown tool would render an expandable row.
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
  });
});
