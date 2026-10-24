import { describe, expect, it } from "vitest";
import { FilePlus, Terminal, Wrench } from "lucide-react";
import { ALL_TOOL_INFOS } from "@/lib/pi/tool-infos";
import { resolveToolCard, splitToolCalls } from "@/components/chat/tool-cards";
import { calendarToolDescriptor } from "@/components/chat/tool-descriptors/calendar";
import { codemodeDescriptor } from "@/components/chat/tool-descriptors/codemode";
import { fileToolDescriptor } from "@/components/chat/tool-descriptors/file";
import { describeGenericToolCall } from "@/components/chat/tool-descriptors/generic";
import { aggregateToolStatus } from "@/components/chat/tool-status";
import { infraToolDescriptor } from "@/components/chat/tool-descriptors/infra";
import { mailToolDescriptor } from "@/components/chat/tool-descriptors/mail";
import { webToolDescriptor } from "@/components/chat/tool-descriptors/web";
import type { ToolCardBlock } from "@/components/chat/tool-card-model";
import type { ToolCallData } from "@/components/chat/types";

/**
 * The card model every tool describes.
 *
 * Descriptors are pure  a tool call in, a model out  so these tests read the
 * model instead of the DOM. That keeps them fast and, more importantly, lets
 * them pin down the *content* (labels, pluralisation, status tones, row data)
 * rather than whichever markup the renderer happens to produce.
 */

function call(
  name: string,
  result: string | undefined,
  extra: Partial<ToolCallData> = {},
): ToolCallData {
  return { id: "tc-1", name, args: {}, status: "completed", result, error: undefined, ...extra };
}

/** A result with a tool's metadata block appended, as the tools write it. */
function withMeta(key: string, meta: Record<string, unknown>, prefix = "Done."): string {
  return `${prefix}\n${JSON.stringify({ [key]: meta })}`;
}

function blocksOf(model: { blocks?: readonly ToolCardBlock[] } | null): ToolCardBlock[] {
  return [...(model?.blocks ?? [])];
}

function firstBlock<K extends ToolCardBlock["kind"]>(
  model: { blocks?: readonly ToolCardBlock[] } | null,
  kind: K,
): Extract<ToolCardBlock, { kind: K }> {
  const block = blocksOf(model).find((candidate) => candidate.kind === kind);
  if (!block)
    throw new Error(`Expected a ${kind} block, got ${blocksOf(model).map((b) => b.kind)}`);
  return block as Extract<ToolCardBlock, { kind: K }>;
}

describe("tool card routing", () => {
  /**
   * Tools whose results carry a format of their own. Everything else in the
   * catalog is deliberately generic, so a new descriptor has to be declared
   * here  and a tool that silently loses its card fails the loop below.
   */
  const DESCRIBED = new Set([
    "show_file",
    "codemode",
    "read",
    "write",
    "edit",
    "web_search",
    "web_fetch",
    "mail_list",
    "mail_search",
    "mail_read",
    "calendar_upcoming",
    "calendar_search",
  ]);

  it("sends every tool with a result format to its own card, and the rest to the generic card", () => {
    const generic = resolveToolCard("not-a-real-tool");

    for (const { name } of ALL_TOOL_INFOS) {
      const described = DESCRIBED.has(name) || name.startsWith("infra_");
      expect(resolveToolCard(name) === generic, name).toBe(!described);
    }
  });

  it("routes a whole family through one card, and unknown names to the generic one", () => {
    expect(resolveToolCard("infra_exec")).toBe(resolveToolCard("infra_notes_delete"));
    expect(resolveToolCard("infra_exec")).not.toBe(resolveToolCard("mail_list"));
    expect(resolveToolCard("bash")).toBe(resolveToolCard("not-a-real-tool"));
  });
});

describe("web descriptor", () => {
  const searchResult = withMeta("_saaleWebMeta", {
    type: "web_search",
    query: "pi coding agent",
    count: 1,
    results: [{ title: "Pi Docs", url: "https://pi.dev/docs/start", engine: "searxng" }],
  });

  it("describes a search with its query, result count and rows", () => {
    const model = webToolDescriptor.describe(call("web_search", searchResult));

    expect(model?.title).toBe("Searched");
    expect(model?.detail).toBe("“pi coding agent”");
    // Singular: the count rule that used to hardcode "1 results".
    expect(model?.status).toEqual({ tone: "success", label: "1 result" });
    // Search results are the answer to the question, so the card opens.
    expect(model?.defaultOpen).toBe(true);

    const rows = firstBlock(model, "rows");
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]?.title).toBe("Pi Docs");
    expect(rows.items[0]?.href).toBe("https://pi.dev/docs/start");
    expect(rows.items[0]?.leading).toEqual({
      kind: "favicon",
      url: "https://www.google.com/s2/favicons?domain=pi.dev&sz=32",
    });
  });

  it("pluralises the count and combines multiple engines", () => {
    const result = withMeta("_saaleWebMeta", {
      type: "web_search",
      query: "x",
      count: 4,
      results: [{ title: "", url: "", engine: "searxng, gh" }],
    });

    const model = webToolDescriptor.describe(call("web_search", result));
    expect(model?.status.label).toBe("4 results");
    // A result with no title falls back to its URL, and an unparseable one
    // still renders rather than dropping the row.
    expect(firstBlock(model, "rows").items[0]?.title).toBe("");
  });

  it("returns null when a search result carries no metadata", () => {
    expect(webToolDescriptor.describe(call("web_search", "No results found."))).toBeNull();
  });

  it("links a successful fetch and names its site", () => {
    const result = withMeta("_saaleWebMeta", {
      type: "web_fetch",
      url: "https://example.com/a/b",
      finalUrl: "https://example.com/b",
      title: "An article",
      siteName: "example.com",
      error: false,
    });

    const model = webToolDescriptor.describe(call("web_fetch", result));

    expect(model?.title).toBe("Fetched");
    expect(model?.detail).toBe("An article");
    expect(model?.status).toEqual({ tone: "success", label: "example.com" });
    expect(model?.action).toEqual({ href: "https://example.com/b", label: "Open example.com" });
    expect(blocksOf(model)).toEqual([]);
  });

  it("reports a failed fetch as an error, with no link to open", () => {
    const result = withMeta("_saaleWebMeta", {
      type: "web_fetch",
      url: "https://gone.example/x",
      title: null,
      siteName: null,
      error: true,
      errorMessage: "connect ETIMEDOUT 203.0.113.9",
    });

    const model = webToolDescriptor.describe(call("web_fetch", result));

    expect(model?.status).toEqual({ tone: "danger", label: "error" });
    expect(model?.action).toBeUndefined();
    // A failure's reason is never behind a click.
    expect(model?.defaultOpen).toBe(true);
    // The domain still shows, so the user can see what failed.
    expect(model?.detail).toBe("gone.example");
    expect(firstBlock(model, "text")).toEqual({
      kind: "text",
      text: "connect ETIMEDOUT 203.0.113.9",
      tone: "danger",
    });
  });
});

describe("mail descriptor", () => {
  const inbox = {
    id: "e1",
    from: "Alice Smith <alice@example.com>",
    subject: "Project update",
    date: "2026-01-01T10:00:00.000Z",
    preview: "Quick update about the roadmap",
    read: false,
    starred: true,
    folder: "Inbox",
  };

  it("describes a listing with unread and starred marks on the row", () => {
    const result = withMeta("_saaleMailMeta", {
      type: "mail_list",
      count: 1,
      total: 5,
      emails: [inbox],
    });

    const model = mailToolDescriptor.describe(call("mail_list", result));

    expect(model?.title).toBe("Listed mail");
    expect(model?.status).toEqual({ tone: "success", label: "1 email" });
    expect(model?.defaultOpen).toBe(true);

    const row = firstBlock(model, "rows").items[0];
    // The sender line is capped at 30 characters, like every card value.
    expect(row?.title).toBe("Alice Smith <alice@example.co…");
    expect(row?.marks).toEqual(["dot", "star"]);
    expect(row?.leading).toMatchObject({ kind: "avatar", label: "AS" });
    expect(row?.lines?.map((line) => line.text)).toEqual([
      "Project update",
      "Quick update about the roadmap",
    ]);
  });

  it("drops the marks for a read, unstarred email", () => {
    const result = withMeta("_saaleMailMeta", {
      type: "mail_list",
      count: 2,
      total: 2,
      emails: [{ ...inbox, read: true, starred: false }],
    });

    const model = mailToolDescriptor.describe(call("mail_list", result));
    expect(model?.status.label).toBe("2 emails");
    expect(firstBlock(model, "rows").items[0]?.marks).toEqual([]);
  });

  it("names the search query and keeps the read subject as the headline", () => {
    const search = mailToolDescriptor.describe(
      call(
        "mail_search",
        withMeta("_saaleMailMeta", {
          type: "mail_search",
          query: "invoice",
          count: 1,
          emails: [inbox],
        }),
      ),
    );
    expect(search?.title).toBe("Searched mail");
    expect(search?.detail).toBe("“invoice”");

    const read = mailToolDescriptor.describe(
      call(
        "mail_read",
        withMeta("_saaleMailMeta", { type: "mail_read", count: 1, emails: [inbox] }),
      ),
    );
    expect(read?.title).toBe("Read mail");
    expect(read?.detail).toBe("Project update");
  });

  it("returns null for a result without metadata, and for a read with no email", () => {
    expect(mailToolDescriptor.describe(call("mail_list", "Listed 0 emails"))).toBeNull();
    expect(
      mailToolDescriptor.describe(
        call("mail_read", withMeta("_saaleMailMeta", { type: "mail_read", count: 0, emails: [] })),
      ),
    ).toBeNull();
  });
});

describe("calendar descriptor", () => {
  const event = {
    id: "ev1",
    summary: "Standup",
    dtStart: "2026-01-02T09:00:00.000Z",
    allDay: false,
    calendarName: "Work",
  };

  it("describes upcoming events with their calendar and time", () => {
    const result = withMeta("_saaleCalMeta", {
      type: "calendar_upcoming",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-08T00:00:00.000Z",
      count: 1,
      events: [event],
    });

    const model = calendarToolDescriptor.describe(call("calendar_upcoming", result));

    expect(model?.title).toBe("Upcoming events");
    expect(model?.status).toEqual({ tone: "success", label: "1 event" });
    // No calendar colour → the mission accent, never an invisible bar.
    expect(firstBlock(model, "rows").items[0]?.accent).toBe("var(--primary)");
  });

  it("keeps a calendar's own colour and flags an all-day event", () => {
    const result = withMeta("_saaleCalMeta", {
      type: "calendar_search",
      query: "holiday",
      count: 2,
      events: [{ ...event, allDay: true, calendarColor: "#ff0000", location: "Lisbon" }],
    });

    const model = calendarToolDescriptor.describe(call("calendar_search", result));
    const row = firstBlock(model, "rows").items[0];

    expect(model?.detail).toBe("“holiday”");
    expect(model?.status.label).toBe("2 events");
    expect(row?.accent).toBe("#ff0000");
    expect(row?.meta?.some((meta) => meta.kind === "badge" && meta.text === "all-day")).toBe(true);
    expect(row?.meta?.some((meta) => meta.kind === "text" && meta.text === "Lisbon")).toBe(true);
  });
});

describe("infra descriptor", () => {
  const exec = (overrides: Record<string, unknown>, extra: Partial<ToolCallData> = {}) =>
    call(
      "infra_exec",
      withMeta("_saaleInfraMeta", {
        type: "infra_exec",
        machineId: "m1",
        machineName: "prod-web-01",
        command: "systemctl restart nginx",
        exitCode: 0,
        timedOut: false,
        truncated: false,
        stdout: "restarted",
        stderr: "",
        ...overrides,
      }),
      extra,
    );

  it("reports the exit code, which is what says whether the command worked", () => {
    expect(infraToolDescriptor.describe(exec({}))?.status).toEqual({
      tone: "success",
      label: "exit 0",
    });
    expect(infraToolDescriptor.describe(exec({ exitCode: 1 }))?.status).toEqual({
      tone: "danger",
      label: "exit 1",
    });
    expect(infraToolDescriptor.describe(exec({ timedOut: true, exitCode: null }))?.status).toEqual({
      tone: "danger",
      label: "timed out",
    });
    // A non-zero exit is a failure even when the call itself never errored.
    expect(infraToolDescriptor.describe(exec({ exitCode: 127 }))?.status.tone).toBe("danger");
  });

  it("stays 'running' while the command is still going, whatever the exit code says", () => {
    const model = infraToolDescriptor.describe(exec({ exitCode: null }, { status: "running" }));
    expect(model?.status).toEqual({ tone: "running", label: "running" });
    expect(model?.defaultOpen).toBeUndefined();
  });

  it("opens a failed command, so its error is not behind a click", () => {
    expect(infraToolDescriptor.describe(exec({ exitCode: 1 }))?.defaultOpen).toBe(true);
    expect(infraToolDescriptor.describe(exec({}))?.defaultOpen).toBeUndefined();
  });

  it("shows the first line of output only, and flags truncated output", () => {
    const model = infraToolDescriptor.describe(
      exec({ stdout: "line one\nline two", stderr: "warn one\nwarn two", truncated: true }),
    );

    expect(firstBlock(model, "output")).toEqual({
      kind: "output",
      stdout: "line one",
      stderr: "warn one",
    });
    expect(firstBlock(model, "facts").items[0]?.badge).toEqual({
      text: "truncated",
      tone: "warn",
    });
  });

  it("omits the output block when the command said nothing", () => {
    const model = infraToolDescriptor.describe(exec({ stdout: "", stderr: "" }));
    expect(blocksOf(model).map((block) => block.kind)).toEqual(["facts"]);
  });

  it("reports a read file's line count, but never for a truncated read", () => {
    const whole = infraToolDescriptor.describe(
      call(
        "infra_read_file",
        withMeta("_saaleInfraMeta", {
          type: "infra_read_file",
          machineId: "m1",
          machineName: "prod-web-01",
          path: "/var/log/app.log",
          truncated: false,
          totalLines: 30,
          preview: "2025-01-01 boot: started",
        }),
      ),
    );

    expect(whole?.title).toBe("Read file");
    expect(firstBlock(whole, "facts").items[0]?.note).toBe("30 lines");
    expect(firstBlock(whole, "text")).toEqual({
      kind: "text",
      text: "2025-01-01 boot: started",
      mono: true,
      clamp: true,
    });

    const truncated = infraToolDescriptor.describe(
      call(
        "infra_read_file",
        withMeta("_saaleInfraMeta", {
          type: "infra_read_file",
          machineId: "m1",
          machineName: "prod-web-01",
          path: "/var/log/huge.log",
          truncated: true,
          totalLines: 9800,
          preview: "2025-01-01 boot: started",
        }),
      ),
    );

    // A truncated read must not claim a complete line count.
    expect(firstBlock(truncated, "facts").items[0]?.note).toBeUndefined();
    expect(firstBlock(truncated, "facts").items[0]?.badge).toEqual({
      text: "truncated",
      tone: "warn",
    });
    expect(truncated?.status.label).toBe("read");
  });

  it("labels a remote image read and keeps its text preview out", () => {
    const model = infraToolDescriptor.describe(
      call(
        "infra_read_file",
        withMeta("_saaleInfraMeta", {
          type: "infra_read_file",
          machineId: "m1",
          machineName: "prod-web-01",
          path: "/var/www/logo.png",
          truncated: false,
          preview: "Read image file [image/png]",
          imageMimeType: "image/png",
        }),
      ),
    );

    expect(model?.title).toBe("Read image");
    expect(blocksOf(model).map((block) => block.kind)).toEqual(["facts"]);
  });

  it("hands an edited file's whole diff to the card, which caps what it shows", () => {
    const diff = Array.from({ length: 45 }, (_, i) => `+${i + 1} line ${i + 1}`).join("\n");
    const model = infraToolDescriptor.describe(
      call(
        "infra_edit_file",
        withMeta("_saaleInfraMeta", {
          type: "infra_edit_file",
          machineId: "m1",
          machineName: "prod-web-01",
          path: "/etc/nginx/nginx.conf",
          replacements: 2,
          firstChangedLine: 2,
          diff,
        }),
      ),
    );

    expect(model?.status.label).toBe("2 edits");
    expect(firstBlock(model, "diff").lines).toHaveLength(45);
    expect(firstBlock(model, "facts").items[0]?.note).toBe("line 2");
  });

  it("colours a note's category badge by what the note holds", () => {
    const model = infraToolDescriptor.describe(
      call(
        "infra_notes_get",
        withMeta("_saaleInfraMeta", {
          type: "infra_notes_get",
          machineId: "m1",
          machineName: "prod-web-01",
          noteId: "n1",
          noteTitle: "Deploy key",
          noteCategory: "credentials",
          contentPreview: "ssh-rsa AAAA…",
        }),
      ),
    );

    expect(model?.detail).toBe("Deploy key");
    expect(firstBlock(model, "facts").items[0]?.badge).toEqual({
      text: "credentials",
      tone: "danger",
    });
  });

  it("names a transfer's local file and sizes it", () => {
    const model = infraToolDescriptor.describe(
      call(
        "infra_download_file",
        withMeta("_saaleInfraMeta", {
          type: "infra_download_file",
          machineId: "m1",
          machineName: "prod-web-01",
          path: "/var/log/app.log",
          localPath: "files/app.log",
          size: 2048,
        }),
      ),
    );

    expect(model?.title).toBe("Downloaded");
    expect(model?.status.label).toBe("2 KB");
    expect(firstBlock(model, "facts").items.map((fact) => fact.text)).toEqual([
      "prod-web-01",
      "files/app.log",
    ]);
  });

  it("returns null for an infra result shape it does not know", () => {
    const model = infraToolDescriptor.describe(
      call(
        "infra_teleport",
        withMeta("_saaleInfraMeta", {
          type: "infra_teleport",
          machineId: "m1",
          machineName: "prod-web-01",
        }),
      ),
    );

    expect(model).toBeNull();
  });
});

describe("codemode descriptor", () => {
  it("lists the tools the script reached, in first-use order", () => {
    const code = [
      "const mails = await tools.mail_list({ folder: 'INBOX' });",
      "const web = await tools.web_search({ query: 'x' });",
      "return [mails, web];",
    ].join("\n");

    const model = codemodeDescriptor.describe(
      call("codemode", "Script completed", { args: { code } }),
    );

    expect(model?.title).toBe("Script");
    // Labels, not the raw identifiers the script called.
    expect(model?.detail).toBe("List Emails · Web Search");
    expect(firstBlock(model, "badges").items).toEqual(["List Emails", "Web Search"]);
    expect(firstBlock(model, "code").text).toBe(code);
  });

  it("falls back to the raw arguments when the script is missing", () => {
    const model = codemodeDescriptor.describe(
      call("codemode", undefined, { args: { step: "one" } }),
    );

    expect(model?.detail).toBeUndefined();
    expect(firstBlock(model, "code").text).toBe("step: one");
  });
});

describe("file descriptor", () => {
  const filePath =
    "/w/user-5ffa02e44299/worktrees/saale/c-188df5a7/src/components/chat/share-viewer.tsx";

  it("shows an edit as a line diff, not the arguments that carry it", () => {
    const model = fileToolDescriptor.describe(
      call("edit", "Successfully replaced 1 block(s) in file.", {
        args: {
          path: filePath,
          edits: [
            {
              oldText: "const messages = props.messages;\nconst count = messages.length;",
              newText:
                "const messages = dropBlankText(props.messages);\nconst count = messages.length;",
            },
          ],
        },
      }),
    );

    expect(model?.title).toBe("Edit");
    // The path keeps its file name, which is the part the header is read for.
    expect(model?.detail?.endsWith("src/components/chat/share-viewer.tsx")).toBe(true);
    expect(model?.status).toEqual({ tone: "success", label: "1 edit" });
    expect(firstBlock(model, "diff")).toEqual({
      kind: "diff",
      // Unchanged lines are context, so a one-line change does not reprint both
      // versions of the whole block.
      lines: [
        "-const messages = props.messages;",
        "+const messages = dropBlankText(props.messages);",
        " const count = messages.length;",
      ],
      max: 60,
    });
  });

  it("separates the diffs of several edits in one call", () => {
    const model = fileToolDescriptor.describe(
      call("edit", "Successfully replaced 2 block(s) in file.", {
        args: {
          path: "src/a.ts",
          edits: [
            { oldText: "one", newText: "two" },
            { oldText: "three", newText: "four" },
          ],
        },
      }),
    );

    expect(model?.status.label).toBe("2 edits");
    expect(firstBlock(model, "diff").lines).toEqual(["-one", "+two", " ", "-three", "+four"]);
  });

  it("counts a write's lines and shows what it wrote", () => {
    const model = fileToolDescriptor.describe(
      call("write", "Successfully wrote to src/a.ts", {
        args: { path: "src/a.ts", content: "one\ntwo\nthree\n" },
      }),
    );

    expect(model?.status).toEqual({ tone: "success", label: "3 lines" });
    expect(firstBlock(model, "code")).toMatchObject({
      label: "Contents",
      text: "one\ntwo\nthree\n",
    });
  });

  it("says a call is preparing rather than counting what it has not written", () => {
    const model = fileToolDescriptor.describe(
      call("write", undefined, {
        status: "pending",
        args: { path: "src/a.ts", content: "one" },
      }),
    );

    expect(model?.status).toEqual({ tone: "running", label: "preparing" });
  });

  it("moves a read's window into facts and shows the contents it returned", () => {
    const model = fileToolDescriptor.describe(
      call("read", "const a = 1;", {
        args: { path: "src/a.ts", offset: 20, limit: 40 },
      }),
    );

    expect(model?.title).toBe("Read");
    expect(model?.detail).toBe("src/a.ts");
    expect(firstBlock(model, "facts").items.map((fact) => fact.text)).toEqual([
      "from line 20",
      "40 lines",
    ]);
    expect(firstBlock(model, "code").text).toBe("const a = 1;");
  });

  it("previews an image a read looked at, with its type in place of a line range", () => {
    const model = fileToolDescriptor.describe(
      call("read", "Read image file [image/png]", {
        args: { path: "reports/mobile-overflow.png" },
      }),
    );

    expect(firstBlock(model, "facts").items.map((fact) => fact.text)).toEqual(["image/png"]);
    expect(firstBlock(model, "image")).toEqual({
      kind: "image",
      path: "reports/mobile-overflow.png",
    });
    // The notice is a report of the read, not its contents.
    expect(blocksOf(model).some((block) => block.kind === "code")).toBe(false);
  });

  it("hands a failed call back to the generic card", () => {
    expect(
      fileToolDescriptor.describe(
        call("edit", "oldText not found", {
          status: "error",
          error: "oldText not found",
          args: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
        }),
      ),
    ).toBeNull();
  });

  it("falls back when there is nothing to draw a diff from", () => {
    expect(
      fileToolDescriptor.describe(call("edit", "ok", { args: { path: "src/a.ts" } })),
    ).toBeNull();
    expect(fileToolDescriptor.describe(call("edit", "ok", { args: {} }))).toBeNull();
  });
});

describe("generic descriptor", () => {
  it("titles a catalog tool with its label and shows its first argument", () => {
    const model = describeGenericToolCall(
      call("bash", "exit 0", { args: { command: "git status\n  --short" } }),
    );

    expect(model.title).toBe("Bash");
    // A multi-line command is flattened for the one-line header.
    expect(model.detail).toBe("git status --short");
    expect(firstBlock(model, "code")).toEqual({
      kind: "code",
      text: "command: git status\n  --short",
      label: "Arguments",
    });
  });

  it("keeps a tool outside the catalog under its own name", () => {
    const model = describeGenericToolCall(call("some_future_tool", undefined));
    expect(model.title).toBe("some_future_tool");
    expect(model.detail).toBeUndefined();
    expect(blocksOf(model)).toEqual([]);
  });

  it("wears the icon the tool's mark wears", () => {
    // `bash` names no icon of its own, so both read the terminal category's.
    expect(describeGenericToolCall(call("bash", "ok")).icon).toBe(Terminal);
    expect(describeGenericToolCall(call("write", "ok")).icon).toBe(FilePlus);
    // A name nothing knows still has to render.
    expect(describeGenericToolCall(call("some_future_tool", undefined)).icon).toBe(Wrench);
  });

  it("labels a failed result as an error and colours it", () => {
    const model = describeGenericToolCall(
      call("bash", "permission denied", { status: "error", error: "exit 1" }),
    );

    expect(model.status).toEqual({ tone: "danger", label: "error" });
    expect(firstBlock(model, "code")).toMatchObject({ label: "Error", tone: "danger" });
    expect(model.defaultOpen).toBe(true);
  });
});

describe("splitting a turn's calls", () => {
  it("separates the files shown to the user from the work, order preserved", () => {
    const { attachments, work } = splitToolCalls([
      call("bash", "ok", { id: "w1" }),
      call("show_file", undefined, { id: "f1" }),
      call("infra_exec", "ok", { id: "w2" }),
      call("show_file", undefined, { id: "f2" }),
    ]);

    expect(work.map((c) => c.id)).toEqual(["w1", "w2"]);
    expect(attachments.map((c) => c.id)).toEqual(["f1", "f2"]);
  });

  it("treats a tool the routing table does not mark as work", () => {
    const { attachments, work } = splitToolCalls([
      call("some_future_tool", undefined, { id: "w1" }),
      call("show_file", undefined, { id: "f1" }),
    ]);

    expect(work.map((c) => c.id)).toEqual(["w1"]);
    expect(attachments.map((c) => c.id)).toEqual(["f1"]);
  });

  it("splits an empty turn into nothing", () => {
    expect(splitToolCalls([])).toEqual({ attachments: [], work: [] });
  });
});

describe("a call whose arguments are still being written", () => {
  const pending = (extra: Partial<ToolCallData> = {}) =>
    call("bash", undefined, { status: "pending", args: { command: "git sta" }, ...extra });

  it("says it is preparing, not that it is running", () => {
    const model = describeGenericToolCall(pending());
    expect(model.status).toEqual({ tone: "running", label: "preparing" });
    // The arguments written so far are on the card: watching a long command
    // appear is the whole point of showing a call before it runs.
    expect(model.blocks).toEqual([{ kind: "code", label: "Arguments", text: "command: git sta" }]);
  });

  it("never reports a failure before the call has run", () => {
    expect(infraToolDescriptor.describe(pending({ name: "infra_exec" }))).toBeNull();
    expect(describeGenericToolCall(pending()).defaultOpen).toBeUndefined();
  });

  it("keeps a run of calls in the running tone while a call is in flight", () => {
    const done = call("bash", "ok");
    expect(aggregateToolStatus([done, pending()])).toEqual({ tone: "running", label: "running" });
    expect(aggregateToolStatus([done])).toEqual({ tone: "success", label: "done" });
  });
});

describe("aggregate status of a run of calls", () => {
  const failed = call("bash", "boom", { status: "error", error: "boom" });
  const running = call("bash", undefined, { status: "running" });

  it("reports a call that is still running, not an earlier failure", () => {
    // A failed call does not end the run: the model often recovers and calls
    // another tool. Freezing the collapsed badge on "failed" made a live run
    // read as finished.
    expect(aggregateToolStatus([failed, running])).toEqual({ tone: "running", label: "running" });
  });

  it("reports a run with a failure once nothing is left in flight", () => {
    expect(aggregateToolStatus([failed, call("bash", "ok")])).toEqual({
      tone: "danger",
      label: "failed",
    });
  });
});
