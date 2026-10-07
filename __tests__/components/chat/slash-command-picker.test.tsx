// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";
import { InputBar } from "@/components/chat/input-bar";
import { listCommands } from "@/lib/commands/catalog";

/**
 * The `/` picker: a command name opens the menu, keys move the highlight, and
 * selecting runs the command instead of sending the text. Anything else stays
 * an ordinary message.
 */

function Harness({
  initial = "",
  onCommand,
  onSend,
}: {
  initial?: string;
  onCommand: () => void;
  onSend: () => void;
}) {
  const [value, setValue] = React.useState(initial);
  return (
    <InputBar
      value={value}
      onValueChange={setValue}
      onSend={onSend}
      onCommand={onCommand}
      isLoading={false}
      onStop={vi.fn()}
    />
  );
}

function renderComposer(initial = "") {
  const onCommand = vi.fn();
  const onSend = vi.fn();
  const utils = render(<Harness initial={initial} onCommand={onCommand} onSend={onSend} />);
  const textarea = utils.container.querySelector("textarea")!;
  return { ...utils, textarea, onCommand, onSend };
}

function type(textarea: HTMLElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

afterEach(() => {
  cleanup();
});

describe("slash command picker", () => {
  it("offers nothing until the composer starts with a slash", () => {
    const { queryByRole } = renderComposer("hello");

    expect(queryByRole("listbox")).toBeNull();
  });

  it("lists the web surface's commands for a bare slash", () => {
    const { textarea, getAllByRole } = renderComposer();

    type(textarea, "/");

    expect(getAllByRole("option")).toHaveLength(listCommands("web").length);
  });

  it("narrows the list to the typed prefix", () => {
    const { textarea, getAllByRole, queryByRole } = renderComposer();

    type(textarea, "/com");

    const options = getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("/compact");
    // A prefix that matches nothing closes the menu again.
    type(textarea, "/zzz");
    expect(queryByRole("listbox")).toBeNull();
  });

  it("picks the highlighted command on Enter and clears the composer", () => {
    const { textarea, onCommand, onSend } = renderComposer();

    type(textarea, "/");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onCommand).toHaveBeenCalledWith("model");
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("");
  });

  it("wraps the highlight back to the top", () => {
    const { textarea, onCommand } = renderComposer();

    type(textarea, "/");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onCommand).toHaveBeenCalledWith(listCommands("web").at(-1)!.name);
  });

  it("runs the exact command when the whole name is typed", () => {
    const { textarea, onCommand } = renderComposer();

    type(textarea, "/compact");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onCommand).toHaveBeenCalledWith("compact");
  });

  it("leaves the text as a message once the menu is dismissed", () => {
    const { textarea, onCommand, onSend } = renderComposer();

    type(textarea, "/compact");
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(textarea).toHaveValue("/compact");

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("/compact", undefined);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("closes the menu once an argument is being typed", () => {
    const { textarea, onCommand, onSend, queryByRole } = renderComposer();

    type(textarea, "/stfu ");
    expect(queryByRole("listbox")).toBeNull();

    fireEvent.keyDown(textarea, { key: "Enter" });

    // `/stfu stop` is parsed by the chat interface, not by the picker.
    expect(onSend).toHaveBeenCalledWith("/stfu", undefined);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("still sends a slash-prefixed message that is not a command", () => {
    const { textarea, onSend, queryByRole } = renderComposer();

    type(textarea, "/not-a-command");

    expect(queryByRole("listbox")).toBeNull();

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("/not-a-command", undefined);
  });
});
