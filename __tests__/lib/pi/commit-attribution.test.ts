import { describe, it, expect } from "vitest";
import { commitAttributionLine } from "@/lib/pi/commit-attribution";
import { DEFAULT_WORKSPACE_NAME } from "@/lib/branding/workspace-name";

/**
 * The line an instance puts on its coder commits: the admin owns the words, the
 * chat owns the id. Off, a chat is told nothing at all.
 */

describe("commitAttributionLine", () => {
  it("is nothing while the trailer switch is off", () => {
    expect(commitAttributionLine({ enabled: false, text: "Co-Authored-By: Saale" }, "c-1")).toBe(
      null,
    );
    // A row no admin has written yet carries neither field.
    expect(commitAttributionLine({}, "c-1")).toBe(null);
  });

  it("fills the chat id in where the line asks for it", () => {
    expect(
      commitAttributionLine({ enabled: true, text: "Co-Authored-By: Saale ({chat})" }, "c-9f2a1b"),
    ).toBe("Co-Authored-By: Saale (c-9f2a1b)");
    expect(
      commitAttributionLine({ enabled: true, text: "{chat} made this ({chat})" }, "c-9f2a1b"),
    ).toBe("c-9f2a1b made this (c-9f2a1b)");
  });

  it("leaves a line that names no chat as written", () => {
    expect(commitAttributionLine({ enabled: true, text: "Attributed-to: Saale" }, "c-1")).toBe(
      "Attributed-to: Saale",
    );
  });

  it("names the workspace when the admin wrote no line", () => {
    expect(commitAttributionLine({ enabled: true, text: "  " }, "c-1")).toBe(
      `Co-Authored-By: ${DEFAULT_WORKSPACE_NAME}`,
    );
    expect(commitAttributionLine({ enabled: true, workspaceName: "Harderwijk" }, "c-1")).toBe(
      "Co-Authored-By: Harderwijk",
    );
    expect(commitAttributionLine({ enabled: true, workspaceName: "  ", text: "" }, "c-1")).toBe(
      `Co-Authored-By: ${DEFAULT_WORKSPACE_NAME}`,
    );
  });

  it("trims the line the admin pasted in", () => {
    expect(commitAttributionLine({ enabled: true, text: "  Co-Authored-By: Saale  " }, "c-1")).toBe(
      "Co-Authored-By: Saale",
    );
  });
});
