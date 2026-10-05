// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallView } from "@/components/chat/tool-call-view";
import type { ToolCallData } from "@/components/chat/types";

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

describe("ToolCallView", () => {
  it("renders a WebSearchCard for web_search with structured meta (happy path)", () => {
    const meta = {
      _saaleWebMeta: {
        type: "web_search",
        query: "pi coding agent",
        count: 2,
        results: [
          { title: "Pi Coding Agent Docs", url: "https://pi.dev/docs", engine: "searxng" },
          { title: "GitHub - pi", url: "https://github.com/pi", engine: "gh" },
        ],
      },
    };
    const result = `Search results for "pi coding agent" (2 results):\n\n1. **[Pi Coding Agent Docs](https://pi.dev/docs)**\n\n${JSON.stringify(meta)}`;

    render(<ToolCallView toolCall={makeToolCall({ name: "web_search", result })} />);

    expect(screen.getByText("Searched")).toBeInTheDocument();
    expect(screen.getByText(/pi coding agent/)).toBeInTheDocument();
    expect(screen.getByText("Pi Coding Agent Docs")).toBeInTheDocument();
    expect(screen.getByText("GitHub - pi")).toBeInTheDocument();
    expect(screen.getByText("2 results")).toBeInTheDocument();
  });

  it("renders a MailToolCard for mail_list with structured meta (happy path)", () => {
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
            date: new Date().toISOString(),
            preview: "Quick update about the roadmap",
            read: false,
            folder: "Inbox",
          },
        ],
      },
    };
    const result = `Listed 1 emails from Inbox.\n\n${JSON.stringify(meta)}`;

    render(<ToolCallView toolCall={makeToolCall({ name: "mail_list", result })} />);

    expect(screen.getByText("Listed mail")).toBeInTheDocument();
    expect(screen.getByText("Project update")).toBeInTheDocument();
    expect(screen.getByText("Inbox")).toBeInTheDocument();
    expect(screen.getByText("1 emails")).toBeInTheDocument();
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

  it("falls back to a generic accordion for unknown tools (edge case)", () => {
    render(<ToolCallView toolCall={makeToolCall({ name: "custom_tool", args: { foo: "bar" } })} />);

    // Accordion header is visible, body is collapsed
    expect(screen.getByText("custom_tool")).toBeInTheDocument();
    expect(screen.queryByText("Arguments:")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /custom_tool/ }));

    expect(screen.getByText("Arguments:")).toBeInTheDocument();
    expect(screen.getByText(/\{\s*"foo": "bar"\s*\}/)).toBeInTheDocument();

    // Collapses again on second click
    fireEvent.click(screen.getByRole("button", { name: /custom_tool/ }));
    expect(screen.queryByText("Arguments:")).not.toBeInTheDocument();
  });

  it("renders an InfraEditFileCard with the diff and replacement count (happy path)", () => {
    const meta = {
      _saaleInfraMeta: {
        type: "infra_edit_file",
        machineId: "m1",
        machineName: "prod-web-01",
        path: "/etc/nginx/nginx.conf",
        replacements: 2,
        firstChangedLine: 2,
        diff: "-2   listen 80;\n+2   listen 8080;\n-3   root /var/www;\n+3   root /srv/www;",
      },
    };
    const result = `{\n "machine": "prod-web-01",\n "replacements": 2\n}\n${JSON.stringify(meta)}`;

    render(<ToolCallView toolCall={makeToolCall({ name: "infra_edit_file", result })} />);

    expect(screen.getByText("Edited file")).toBeInTheDocument();
    expect(screen.getByText("/etc/nginx/nginx.conf")).toBeInTheDocument();
    expect(screen.getByText("2 edits")).toBeInTheDocument();
    expect(screen.getByText("prod-web-01")).toBeInTheDocument();
    expect(screen.getByText("line 2")).toBeInTheDocument();
    expect(screen.getByText("-2 listen 80;")).toHaveClass("text-red-700");
    expect(screen.getByText("+2 listen 8080;")).toHaveClass("text-green-700");
  });

  it("summarises a long diff instead of rendering every line (edge case)", () => {
    const diffLines = Array.from({ length: 45 }, (_, i) => `+${i + 1} line ${i + 1}`);
    const meta = {
      _saaleInfraMeta: {
        type: "infra_edit_file",
        machineId: "m1",
        machineName: "prod-web-01",
        path: "/etc/app.conf",
        replacements: 45,
        diff: diffLines.join("\n"),
      },
    };

    render(
      <ToolCallView
        toolCall={makeToolCall({ name: "infra_edit_file", result: JSON.stringify(meta) })}
      />,
    );

    expect(screen.getByText("+40 line 40")).toBeInTheDocument();
    expect(screen.queryByText("+41 line 41")).not.toBeInTheDocument();
    expect(screen.getByText("5 more lines")).toBeInTheDocument();
  });

  it("renders an InfraReadFileCard and flags truncated output", () => {
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

    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.getByText("/var/log/huge.log")).toBeInTheDocument();
    expect(screen.getByText("truncated")).toBeInTheDocument();
    expect(screen.getByText(/2025-01-01 boot/)).toBeInTheDocument();
    // A truncated read must not claim a complete line count.
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

  it("renders nothing for web_search when the result has no structured meta (edge case)", () => {
    render(
      <ToolCallView
        toolCall={makeToolCall({
          name: "web_search",
          result: 'Search results for "query" (0 results):\n\nNo results found.',
        })}
      />,
    );

    expect(screen.queryByText("Searched")).not.toBeInTheDocument();
  });
});
