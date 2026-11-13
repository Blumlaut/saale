import { describe, expect, it } from "vitest";

import { latestShownFile, SHOW_FILE_TOOL_NAME } from "@/lib/chat/shown-file";

const shared = (id: string, filePath: string, status = "completed") => ({
  toolCalls: [{ id, name: SHOW_FILE_TOOL_NAME, status, args: { filePath } }],
});

describe("latestShownFile", () => {
  it("names the newest shared file, with the id that makes it a new show", () => {
    expect(latestShownFile([shared("a", "notes.md"), shared("b", "report.md")])).toEqual({
      id: "b",
      path: "report.md",
    });
  });

  it("ignores a share whose call is still running", () => {
    expect(latestShownFile([shared("a", "notes.md"), shared("b", "report.md", "running")])).toEqual(
      { id: "a", path: "notes.md" },
    );
  });

  it("ignores another tool's call", () => {
    const messages = [
      shared("a", "notes.md"),
      { toolCalls: [{ id: "b", name: "read", status: "completed", args: { path: "x.ts" } }] },
    ];
    expect(latestShownFile(messages)).toEqual({ id: "a", path: "notes.md" });
  });

  it("stays quiet for a file the panel cannot render", () => {
    // A zip is delivered by the transcript card. opening the panel for it would
    // promise a view of bytes the viewer refuses.
    expect(latestShownFile([shared("a", "notes.md"), shared("b", "bundle.zip")])).toBeNull();
  });

  it("reports the image a share named", () => {
    expect(latestShownFile([shared("a", "shots/overview.png")])).toEqual({
      id: "a",
      path: "shots/overview.png",
    });
  });
});
