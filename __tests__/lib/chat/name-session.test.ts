import { describe, expect, it } from "vitest";
import { promptTitleFields } from "@/lib/chat/name-session";

describe("promptTitleFields", () => {
  it("names a chat from the prompt that opened it", () => {
    expect(promptTitleFields("default", "can you fix the flaky e2e test")).toEqual({
      title: "Fix flaky e2e test",
      titleSource: "auto",
    });
  });

  it("quotes a prompt that says nothing and keeps the chat nameable", () => {
    const fields = promptTitleFields("default", "hi");
    expect(fields).toEqual({ title: "hi" });
  });

  it("leaves a named chat alone", () => {
    expect(promptTitleFields("user", "add a dark mode toggle")).toBeNull();
    expect(promptTitleFields("auto", "add a dark mode toggle")).toBeNull();
    expect(promptTitleFields("ai", "add a dark mode toggle")).toBeNull();
  });

  it("caps a quoted prompt at the title length", () => {
    const fields = promptTitleFields("default", "x".repeat(80));
    expect(fields!.title).toHaveLength(50);
    expect(fields!.title.endsWith("...")).toBe(true);
  });
});
