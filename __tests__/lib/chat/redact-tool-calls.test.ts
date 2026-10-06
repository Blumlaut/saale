import { describe, it, expect, vi } from "vitest";
import { ALL_TOOL_INFOS } from "@/lib/pi/tool-infos";
import {
  parseStoredToolCalls,
  redactStoredToolCalls,
  redactToolCallForShare,
  redactToolCallsForShare,
  summarizeToolCallForShare,
  type RedactableToolCall,
} from "@/lib/chat/redact-tool-calls";

/**
 * Tool results as the tools actually shape them: human-readable text with a
 * `_saale*Meta` JSON block appended (see src/lib/pi/tools/*-tools.ts).
 */
function withMeta(text: string, meta: Record<string, unknown>): string {
  return `${text}\n${JSON.stringify(meta)}`;
}

const infraExec: RedactableToolCall = {
  id: "tc-exec",
  name: "infra_exec",
  args: { machineId: "m1", command: "ffprobe -show_format /legoshiba/cloud/music/x.flac" },
  result: withMeta("ffprobe output here", {
    _saaleInfraMeta: {
      type: "infra_exec",
      machineId: "m1",
      machineName: "cloud-prod-environment",
      command: "ffprobe -show_format /legoshiba/cloud/music/x.flac",
      exitCode: 0,
      timedOut: false,
      truncated: false,
      stdout: "ubuntu@10.0.0.4: /legoshiba 7.0T available",
      stderr: "",
    },
  }),
  isError: false,
};

const mailRead: RedactableToolCall = {
  id: "tc-mail",
  name: "mail_read",
  args: { id: "abc", accountId: "acc1" },
  result: withMeta("Email body", {
    _saaleMailMeta: {
      type: "mail_read",
      count: 1,
      emails: [
        {
          id: "abc",
          from: "Ada Lovelace <ada@example.com>",
          to: "me@blumlaut.me",
          subject: "Q3 bonus payout details",
          date: "2026-01-01T00:00:00Z",
          preview: "Your payout of 12,000 EUR lands on Friday",
          read: true,
          folder: "INBOX",
          bodyText: "The full body with the IBAN DE89370400440532013000",
        },
      ],
    },
  }),
  isError: false,
};

const calendar: RedactableToolCall = {
  id: "tc-cal",
  name: "calendar_upcoming",
  args: { days: 7 },
  result: withMeta("Upcoming events", {
    _saaleCalMeta: {
      type: "calendar_upcoming",
      count: 2,
      events: [{ summary: "Therapy appointment", location: "Praxis Dr. Weber" }],
    },
  }),
  isError: false,
};

const webSearch: RedactableToolCall = {
  id: "tc-web",
  name: "web_search",
  args: { query: "how to remove a tattoo at home" },
  result: withMeta('Search results for "how to remove a tattoo at home"', {
    _saaleWebMeta: {
      type: "web_search",
      query: "how to remove a tattoo at home",
      count: 8,
      results: [{ title: "Reddit thread", url: "https://reddit.com/r/x", engine: "google" }],
    },
  }),
  isError: false,
};

const infraEdit: RedactableToolCall = {
  id: "tc-edit",
  name: "infra_edit_file",
  args: { machineId: "m1", path: "/lancache/wolfgun-dl/place_album.py" },
  result: withMeta("Edited", {
    _saaleInfraMeta: {
      type: "infra_edit_file",
      machineId: "m1",
      machineName: "cloud-prod-environment",
      path: "/lancache/wolfgun-dl/place_album.py",
      replacements: 1,
      diff: "-password = 'hunter2'\n+password = os.environ['PW']",
    },
  }),
  isError: false,
};

const chatSearch: RedactableToolCall = {
  id: "tc-chat",
  name: "chat_search",
  args: { query: "divorce lawyer" },
  result: "Found 3 sessions:\n- discussion about the divorce lawyer in Munich",
  isError: false,
};

const unknownTool: RedactableToolCall = {
  id: "tc-unknown",
  name: "some_future_tool",
  args: { secretPath: "/home/blumlaut/.ssh/id_ed25519", token: "sk-live-abc123" },
  result: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA",
  isError: false,
};

const failedExec: RedactableToolCall = {
  ...infraExec,
  id: "tc-fail",
  isError: true,
  result: "curl: (23) failed to open /lancache/wolfgun-dl/x.zip",
};

const ALL_CALLS = [
  infraExec,
  mailRead,
  calendar,
  webSearch,
  infraEdit,
  chatSearch,
  unknownTool,
  failedExec,
];

describe("redactToolCallForShare", () => {
  it("strips args, result and error but keeps identity and status", () => {
    const redacted = redactToolCallForShare(failedExec);

    expect(redacted.id).toBe("tc-fail");
    expect(redacted.name).toBe("infra_exec");
    expect(redacted.isError).toBe(true);
    expect(redacted.args).toEqual({});
    expect(redacted.result).toBeUndefined();
    expect(redacted.error).toBeUndefined();
  });

  it("does not mutate the persisted call it was given", () => {
    const original = structuredClone(mailRead);
    redactToolCallForShare(mailRead);

    expect(mailRead).toEqual(original);
  });

  it("summarizes each tool without echoing its output", () => {
    expect(summarizeToolCallForShare("infra_exec", infraExec.result)).toBe(
      "Ran a command in the terminal",
    );
    expect(summarizeToolCallForShare("mail_read", mailRead.result)).toBe("Read mail · 1 email");
    expect(summarizeToolCallForShare("web_search", webSearch.result)).toBe(
      "Searched the web · 8 results",
    );
    expect(summarizeToolCallForShare("calendar_upcoming", calendar.result)).toBe(
      "Checked the calendar · 2 events",
    );
  });

  it("falls back to a generic summary for a tool it has never seen", () => {
    expect(summarizeToolCallForShare("some_future_tool", unknownTool.result)).toBe("Ran a tool");
    expect(redactToolCallForShare(unknownTool).redacted).toBe("Ran a tool");
  });

  it("drops the count when the meta block is missing, truncated or not a number", () => {
    expect(summarizeToolCallForShare("web_search", undefined)).toBe("Searched the web");
    expect(summarizeToolCallForShare("web_search", "no meta here")).toBe("Searched the web");
    expect(summarizeToolCallForShare("web_search", '{"_saaleWebMeta":{')).toBe("Searched the web");
    expect(
      summarizeToolCallForShare("web_search", withMeta("x", { _saaleWebMeta: { count: "many" } })),
    ).toBe("Searched the web");
  });

  it("logs instead of throwing when the meta block is invalid JSON", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Braces balance, so the block is handed to JSON.parse and rejected there.
    const rule = summarizeToolCallForShare("web_search", '{"_saaleWebMeta":{count:}}');

    expect(rule).toBe("Searched the web");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("gives up quietly on a truncated block rather than scanning for a brace that never closes", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(summarizeToolCallForShare("web_search", '{"_saaleWebMeta":{"count":12')).toBe(
      "Searched the web",
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("public share payload", () => {
  /**
   * The assertion that matters: serialize exactly what the endpoint serves and
   * assert none of the fixture's sensitive values appear anywhere in it. A
   * per-field test can pass while a new field quietly rides along.
   */
  it("contains none of the sensitive values from the tool results", () => {
    const payload = JSON.stringify({
      messages: [{ role: "assistant", toolCalls: redactToolCallsForShare(ALL_CALLS) }],
    });

    const forbidden = [
      // paths
      "/legoshiba",
      "/lancache",
      "/home/blumlaut",
      "/.ssh",
      // infrastructure
      "cloud-prod-environment",
      "ubuntu@",
      "10.0.0.4",
      // mail
      "ada@example.com",
      "me@blumlaut.me",
      "Q3 bonus payout",
      "12,000 EUR",
      "DE89370400440532013000",
      "INBOX",
      "Email body",
      // calendar
      "Therapy appointment",
      "Praxis Dr. Weber",
      // web
      "tattoo",
      "reddit.com",
      // commands, output and diffs
      "ffprobe",
      "hunter2",
      "OPENSSH PRIVATE KEY",
      "curl: (23)",
      "7.0T available",
      // other conversations
      "divorce lawyer",
      // generic args
      "sk-live-abc123",
    ];

    for (const value of forbidden) {
      expect(payload).not.toContain(value);
    }
  });

  it("keeps one redacted tool call per input call, in order", () => {
    const redacted = redactToolCallsForShare(ALL_CALLS);

    expect(redacted.map((c) => c.id)).toEqual(ALL_CALLS.map((c) => c.id));
    expect(redacted.every((c) => c.redacted.length > 0)).toBe(true);
  });
});

describe("parseStoredToolCalls", () => {
  it("parses a persisted array", () => {
    expect(parseStoredToolCalls(JSON.stringify([infraExec]))).toHaveLength(1);
  });

  it("returns an empty list for null, empty, malformed or non-array values", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(parseStoredToolCalls(null)).toEqual([]);
    expect(parseStoredToolCalls(undefined)).toEqual([]);
    expect(parseStoredToolCalls("")).toEqual([]);
    expect(parseStoredToolCalls("not json")).toEqual([]);
    expect(parseStoredToolCalls('{"id":"x"}')).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("redactStoredToolCalls", () => {
  it("round-trips a stored column into a redacted JSON string", () => {
    const stored = redactStoredToolCalls(JSON.stringify([infraExec, mailRead]));

    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.redacted).toBe("Ran a command in the terminal");
    expect(parsed[0]?.args).toEqual({});
    expect(stored).not.toContain("/legoshiba");
  });

  it("returns null when there is nothing to store", () => {
    expect(redactStoredToolCalls(null)).toBeNull();
    expect(redactStoredToolCalls("[]")).toBeNull();
  });
});

/**
 * Guards that keep redaction true for tools that do not exist yet.
 *
 * Both sweeps read `ALL_TOOL_INFOS`, the catalog the UI and the tool registry
 * are built from, so a tool added there is covered the moment it lands — no
 * one has to remember this file.
 */
describe("catalog coverage", () => {
  /** Deliberately distinctive: if this survives, something copied a value out. */
  const CANARY = "9f3a2b7c-quarantine";

  const poisoned: RedactableToolCall = {
    id: "tc-canary",
    name: "unknown",
    args: { filePath: `/home/blumlaut/${CANARY}.flac`, query: CANARY },
    result: withMeta(`ffprobe ${CANARY}`, {
      _saaleInfraMeta: {
        type: "infra_exec",
        machineName: "cloud-prod-environment",
        command: `rm -rf /lancache/${CANARY}`,
        output: CANARY,
      },
    }),
    isError: true,
  };

  it("has a hand-written summary for every tool in the catalog", () => {
    const generic = ALL_TOOL_INFOS.map((info) => info.name).filter(
      (name) => summarizeToolCallForShare(name, undefined) === "Ran a tool",
    );

    expect(
      generic,
      `Add a SUMMARY_RULES entry for each of these in src/lib/chat/redact-tool-calls.ts:\n` +
        generic.map((name) => `  - ${name}`).join("\n"),
    ).toEqual([]);
  });

  it("drops args, results and errors for every tool in the catalog (default-deny)", () => {
    for (const { name } of ALL_TOOL_INFOS) {
      const [redacted] = redactToolCallsForShare([{ ...poisoned, name }]);

      expect(redacted?.name, name).toBe(name);
      expect(redacted?.args, name).toEqual({});
      expect(redacted?.result, name).toBeUndefined();
      expect(redacted?.error, name).toBeUndefined();
      expect(JSON.stringify(redacted), name).not.toContain(CANARY);
      expect(JSON.stringify(redacted), name).not.toContain("cloud-prod-environment");
      expect(redacted?.redacted, name).toBeTruthy();
    }
  });

  it("is default-deny for a tool that is not in the catalog at all", () => {
    const [redacted] = redactToolCallsForShare([{ ...poisoned, name: "some_future_tool" }]);

    expect(redacted?.args).toEqual({});
    expect(redacted?.result).toBeUndefined();
    expect(redacted?.redacted).toBe("Ran a tool");
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
  });
});
