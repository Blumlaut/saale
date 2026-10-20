import { describe, it, expect } from "vitest";
import {
  describeToolAction,
  summarizeToolAction,
  formatDateTimeValue,
  humanizeKey,
  formatToolSummary,
} from "@/lib/pi/tool-infos";

describe("humanizeKey", () => {
  it("splits camelCase", () => {
    expect(humanizeKey("dtStart")).toBe("Dt Start");
    expect(humanizeKey("sessionId")).toBe("Session Id");
  });

  it("splits snake_case and kebab-case", () => {
    expect(humanizeKey("run_id")).toBe("Run id");
    expect(humanizeKey("max-chars")).toBe("Max chars");
  });

  it("capitalizes the first letter", () => {
    expect(humanizeKey("path")).toBe("Path");
  });
});

describe("formatDateTimeValue", () => {
  it("formats a full ISO datetime", () => {
    const out = formatDateTimeValue("2026-03-05T15:30:00Z");
    expect(out).toMatch(/Mar 5, 2026/);
    expect(out).toMatch(/\d{1,2}:30/);
  });

  it("formats a date-only value without a time", () => {
    const out = formatDateTimeValue("2026-03-05");
    expect(out).toMatch(/Mar 5, 2026/);
    expect(out).not.toMatch(/:30|PM|AM/);
  });

  it("returns null for non-date strings", () => {
    expect(formatDateTimeValue("not a date")).toBeNull();
    expect(formatDateTimeValue(12345)).toBeNull();
    expect(formatDateTimeValue(null)).toBeNull();
    expect(formatDateTimeValue("2026-13-99T00:00:00Z")).toBeNull();
  });
});

describe("summarizeToolAction", () => {
  it("prefers the catalog summaryTemplate", () => {
    expect(summarizeToolAction("web_search", { query: "pi agent" })).toBe(
      'Searching web for "pi agent"',
    );
    // Templates win even when a builder also exists
    expect(summarizeToolAction("mail_search", { query: "invoice" })).toBe(
      'Searching emails for "invoice"',
    );
  });

  it("summarizes mail_send from to + subject", () => {
    expect(
      summarizeToolAction("mail_send", {
        to: ["jane@example.com"],
        subject: "Re: Invoice",
        body: "hi",
      }),
    ).toBe('Send email to jane@example.com. "Re: Invoice"');
  });

  it("caps long recipient lists", () => {
    expect(
      summarizeToolAction("mail_send", {
        to: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"],
        subject: "All",
      }),
    ).toBe('Send email to a@x.com, b@x.com, c@x.com and 1 more. "All"');
  });

  it("summarizes calendar_create with humanized start", () => {
    expect(
      summarizeToolAction("calendar_create", {
        summary: "Team lunch",
        dtStart: "2026-03-05T15:30:00Z",
      }),
    ).toMatch(/^Create event "Team lunch". Mar 5, 2026/);
  });

  it("summarizes task_create with due date", () => {
    expect(
      summarizeToolAction("task_create", { title: "Pay invoice", dueDate: "2026-03-05" }),
    ).toBe('Create task "Pay invoice" (due Mar 5, 2026)');
    expect(summarizeToolAction("task_create", { title: "Pay invoice" })).toBe(
      'Create task "Pay invoice"',
    );
  });

  it("truncates multi-line bash commands to the first line", () => {
    expect(summarizeToolAction("bash", { command: "echo hi\necho bye" })).toBe("Run: echo hi");
  });

  it("truncates very long first lines", () => {
    const long = "x".repeat(200);
    const out = summarizeToolAction("bash", { command: long });
    expect(out).toBe(`Run: ${"x".repeat(80)}…`);
  });

  it("uses the settings_set catalog template (the value shows in the fields)", () => {
    expect(summarizeToolAction("settings_set", { key: "model.chat", value: "gpt-5" })).toBe(
      "Changing setting model.chat",
    );
  });

  it("returns null for id-only tools (server resolves the subject)", () => {
    expect(summarizeToolAction("calendar_delete", { id: "cln_1" })).toBeNull();
    expect(summarizeToolAction("task_delete", { taskId: "tsk_1" })).toBeNull();
    expect(summarizeToolAction("chat_respond", { sessionId: "cs_1", message: "hi" })).toBeNull();
    expect(summarizeToolAction("job_run", { id: "qt_1" })).toBeNull();
  });

  it("returns null when the tool and template/builder are unknown", () => {
    expect(summarizeToolAction("mcp_myserver_fetch", { url: "https://x" })).toBeNull();
  });
});

describe("describeToolAction", () => {
  it("maps argument keys to friendly labels for known tools", () => {
    const action = describeToolAction("mail_send", {
      to: ["jane@example.com"],
      subject: "Re: Invoice",
      body: "Line 1\nLine 2",
    });

    expect(action.label).toBe("Send Email");
    expect(action.known).toBe(true);
    expect(action.fields.map((f) => f.label)).toEqual(["To", "Subject", "Body"]);
    expect(action.summary).toBe('Send email to jane@example.com. "Re: Invoice"');
  });

  it("humanizes unknown argument keys of known tools", () => {
    const action = describeToolAction("calendar_create", {
      someNewArg: "x",
    });
    expect(action.fields.map((f) => f.label)).toEqual(["Some New Arg"]);
  });

  it("falls back gracefully for unknown (e.g. MCP) tools", () => {
    const action = describeToolAction("mcp_myserver_fetch", {
      url: "https://x",
      headers: { a: "b" },
    });

    expect(action.known).toBe(false);
    expect(action.label).toBe("mcp_myserver_fetch");
    expect(action.description).toBe("");
    expect(action.summary).toBeNull();
    expect(action.fields.map((f) => [f.key, f.label])).toEqual([
      ["url", "Url"],
      ["headers", "Headers"],
    ]);
  });

  it("keeps the raw args order in fields", () => {
    const action = describeToolAction("task_create", {
      tags: ["a"],
      title: "T",
      priority: "high",
    });
    expect(action.fields.map((f) => f.key)).toEqual(["tags", "title", "priority"]);
  });
});

describe("formatToolSummary (regression)", () => {
  it("still resolves infra templates", () => {
    expect(formatToolSummary("infra_exec", { command: "ls", machineName: "prod" })).toBe(
      "Running ls on prod",
    );
  });
});
