// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApprovalMessage } from "@/components/chat/approval-message";
import type { ApprovalData } from "@/components/chat/types";

function makeApproval(overrides: Partial<ApprovalData> = {}): ApprovalData {
  return {
    toolCallId: "tc-1",
    toolName: "mail_send",
    args: {
      to: ["jane@example.com"],
      subject: "Re: Invoice",
      body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7",
    },
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("ApprovalMessage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the friendly label and the server-resolved summary", () => {
    render(
      <ApprovalMessage
        sessionId="cs-1"
        approval={makeApproval({ summary: 'Send email to jane@example.com. "Re: Invoice"' })}
        onResolved={() => {}}
      />,
    );

    expect(screen.getByText("Send Email")).toBeInTheDocument();
    expect(screen.getByText('Send email to jane@example.com. "Re: Invoice"')).toBeInTheDocument();
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
  });

  it("prefers the server-enriched summary for id-only tools", () => {
    render(
      <ApprovalMessage
        sessionId="cs-1"
        approval={makeApproval({
          toolName: "task_delete",
          args: { taskId: "tsk_1" },
          summary: 'Delete task "Pay invoice #42"',
        })}
        onResolved={() => {}}
      />,
    );

    expect(screen.getByText('Delete task "Pay invoice #42"')).toBeInTheDocument();
    expect(screen.getByText("Task:")).toBeInTheDocument();
    expect(screen.getByText("tsk_1")).toBeInTheDocument();
  });

  it("shows what one approval covers when it stands in for several calls", () => {
    render(
      <ApprovalMessage
        sessionId="cs-1"
        approval={makeApproval({
          toolName: "codemode",
          args: { code: "await tools.mail_send({}); await tools.task_delete({});" },
          summary: "Run codemode script: await tools.mail_send({});",
          batch: { tools: ["mail_send", "task_delete"] },
        })}
        onResolved={() => {}}
      />,
    );

    expect(screen.getByText("One approval covers these 2 calls:")).toBeInTheDocument();
    expect(screen.getByText("Send Email")).toBeInTheDocument();
    expect(screen.getByText("Delete Task")).toBeInTheDocument();
    // Nothing says the script can reach further than the list.
    expect(screen.queryByText(/pick tools by name/)).not.toBeInTheDocument();
  });

  it("says when the covered list may not be the whole plan", () => {
    render(
      <ApprovalMessage
        sessionId="cs-1"
        approval={makeApproval({
          toolName: "codemode",
          args: { code: "await tools.mail_send({});" },
          batch: { tools: ["mail_send"], dynamic: true },
        })}
        onResolved={() => {}}
      />,
    );

    expect(screen.getByText("One approval covers this call:")).toBeInTheDocument();
    expect(screen.getByText(/pick tools by name/)).toBeInTheDocument();
  });

  it("shows labeled fields and hides the raw-arguments dump by default", () => {
    render(<ApprovalMessage sessionId="cs-1" approval={makeApproval()} onResolved={() => {}} />);

    // Friendly labels, not raw keys
    expect(screen.getByText("To:")).toBeInTheDocument();
    expect(screen.getByText("Subject:")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    expect(screen.getByText("Re: Invoice")).toBeInTheDocument();

    // Raw args are behind a collapsed toggle
    expect(screen.getByText("Raw arguments")).toBeInTheDocument();
    expect(screen.queryByText(/to: \[/)).not.toBeInTheDocument();
  });

  it("expands the raw arguments on demand", () => {
    render(<ApprovalMessage sessionId="cs-1" approval={makeApproval()} onResolved={() => {}} />);

    fireEvent.click(screen.getByText("Raw arguments"));
    expect(screen.getByText(/to: \[/)).toBeInTheDocument();
  });

  it("clips multi-line bodies and expands them on demand", () => {
    render(<ApprovalMessage sessionId="cs-1" approval={makeApproval()} onResolved={() => {}} />);

    // Clipped to 6 lines: the 7th line is not visible yet
    expect(screen.queryByText(/Line 7/)).not.toBeInTheDocument();
    const showMore = screen.getByText("Show more");
    fireEvent.click(showMore);
    expect(screen.getByText(/Line 7/)).toBeInTheDocument();
    expect(screen.getByText("Show less")).toBeInTheDocument();
  });

  it("derives a client-side summary when the request has none (pre-existing record)", () => {
    render(<ApprovalMessage sessionId="cs-1" approval={makeApproval()} onResolved={() => {}} />);

    // No server summary → the argument-derived one from the catalog
    expect(screen.getByText('Send email to jane@example.com. "Re: Invoice"')).toBeInTheDocument();
  });

  it("falls back to the raw tool name and humanized keys for unknown tools", () => {
    render(
      <ApprovalMessage
        sessionId="cs-1"
        approval={makeApproval({
          toolName: "mcp_myserver_fetch",
          args: { url: "https://x.dev" },
          summary: null,
        })}
        onResolved={() => {}}
      />,
    );

    expect(screen.getByText("mcp_myserver_fetch")).toBeInTheDocument();
    expect(screen.getByText("Url:")).toBeInTheDocument();
    expect(screen.getByText("https://x.dev")).toBeInTheDocument();
  });

  it("posts an approval and reports resolution on success", async () => {
    const onResolved = vi.fn();
    render(<ApprovalMessage sessionId="cs-1" approval={makeApproval()} onResolved={onResolved} />);

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/chat/sessions/cs-1/approve-tool",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ toolCallId: "tc-1", approved: true }),
        }),
      );
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("tc-1"));
    await waitFor(() => expect(screen.getByText("Approved")).toBeInTheDocument());
  });

  it("posts a denial on deny", async () => {
    const onResolved = vi.fn();
    render(<ApprovalMessage sessionId="cs-1" approval={makeApproval()} onResolved={onResolved} />);

    fireEvent.click(screen.getByText("Deny"));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/chat/sessions/cs-1/approve-tool",
        expect.objectContaining({
          body: JSON.stringify({ toolCallId: "tc-1", approved: false }),
        }),
      );
    });
    await waitFor(() => expect(screen.getByText("Denied")).toBeInTheDocument());
  });

  it("renders a compact resolved line when the approval was already resolved", () => {
    render(
      <ApprovalMessage
        sessionId="cs-1"
        approval={makeApproval({ resolved: true, approved: true })}
        onResolved={() => {}}
      />,
    );

    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });
});
