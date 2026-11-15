// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";
import { InputBar } from "@/components/chat/input-bar";
import { listCommands } from "@/lib/commands/catalog";

/**
 * The `/` picker: a command name opens the menu, keys move the highlight, and
 * picking a command with arguments leaves it in the composer ready to fill in.
 * Anything else stays an ordinary message.
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

  it("says what each command takes, so a file-taking one reads that way", () => {
    const { textarea, getAllByRole } = renderComposer();

    type(textarea, "/ed");

    const row = getAllByRole("option")[0]!;
    expect(row).toHaveTextContent("/edit");
    expect(row).toHaveTextContent("prompt: files: size:");
  });

  it("narrows the list to the typed prefix", () => {
    const { textarea, getAllByRole, queryByRole } = renderComposer();

    type(textarea, "/com");

    // "compact" by name, "edit" by its description ("combine").
    const options = getAllByRole("option");
    expect(options[0]).toHaveTextContent("/compact");
    expect(options).toHaveLength(2);
    // A prefix that matches nothing closes the menu again.
    type(textarea, "/zzz");
    expect(queryByRole("listbox")).toBeNull();
  });

  it("picks the highlighted command on Enter and clears the composer", () => {
    const { textarea, onCommand, onSend } = renderComposer();

    type(textarea, "/com");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onCommand).toHaveBeenCalledWith("compact");
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("");
  });

  it("wraps the highlight to the last command, which waits for its arguments", () => {
    const { textarea, onCommand } = renderComposer();

    type(textarea, "/");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onCommand).not.toHaveBeenCalled();
    expect(textarea).toHaveValue(`/${listCommands("web").at(-1)!.name} `);
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

  it("still sends a slash-prefixed message that is not a command", () => {
    const { textarea, onSend, queryByRole } = renderComposer();

    type(textarea, "/not-a-command");

    expect(queryByRole("listbox")).toBeNull();

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("/not-a-command", undefined);
  });
});

describe("composer highlight", () => {
  /** The runs the mirror painted, as `kind:text`. */
  function runs(container: HTMLElement) {
    return [...container.querySelectorAll("[data-slot='composer-highlight'] [data-kind]")].map(
      (span) => `${span.getAttribute("data-kind")}:${span.textContent}`,
    );
  }

  it("paints the command name and the arguments being filled in", () => {
    const { container } = renderComposer("/edit prompt:make it night size:");

    expect(runs(container)).toEqual([
      "command:/edit",
      "plain: ",
      "label:prompt:",
      "value:make it night",
      "plain: ",
      "label:size:",
    ]);
  });

  it("keeps the mirror on exactly the text that was typed", () => {
    const { container, textarea } = renderComposer("/image prompt:a red fox size:1024x1024");

    const painted = [...container.querySelectorAll("[data-slot='composer-highlight'] [data-kind]")]
      .map((span) => span.textContent)
      .join("");
    expect(painted).toBe("/image prompt:a red fox size:1024x1024");
    expect(textarea).toHaveValue(painted);
  });

  it("paints nothing for an ordinary message", () => {
    const { container } = renderComposer("what does /image do?");

    expect(container.querySelector("[data-slot='composer-highlight']")).toBeNull();
  });

  it("paints nothing for a command the catalog does not know", () => {
    const { container } = renderComposer("/notacommand prompt:x");

    expect(container.querySelector("[data-slot='composer-highlight']")).toBeNull();
  });
});

describe("command arguments", () => {
  /** The highlighted row of the argument menu, by its visible name. */
  function argumentRow(utils: ReturnType<typeof renderComposer>, name: string) {
    return utils.getAllByRole("option").find((row) => row.textContent?.includes(name));
  }

  it("offers the arguments of a picked command instead of running it", () => {
    const { textarea, onCommand, getAllByRole } = renderComposer();

    type(textarea, "/image");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onCommand).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("/image ");
    expect(getAllByRole("option").map((row) => row.textContent)).toEqual([
      expect.stringContaining("prompt:"),
      expect.stringContaining("size:"),
    ]);
  });

  it("completes the highlighted argument into the composer", () => {
    const { textarea } = renderComposer("/image ");

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea).toHaveValue("/image prompt:");
  });

  it("says nothing while a free-text value is being typed", () => {
    renderComposer("/image prompt:a red fox");

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("offers what is left once the value is done", () => {
    const { textarea } = renderComposer("/image prompt:a red fox ");

    const rows = document.querySelectorAll('[role="option"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("size:");

    // Tab takes the optional argument; Enter would run the command.
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(textarea).toHaveValue("/image prompt:a red fox size:");
  });

  it("filters the arguments as a name is typed", () => {
    const { textarea } = renderComposer("/image s");

    const rows = document.querySelectorAll('[role="option"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("size:");

    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(textarea).toHaveValue("/image size:");
  });

  it("offers a choice's values and fills one in", () => {
    const { textarea } = renderComposer("/stfu time:p");

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea).toHaveValue("/stfu time:permanent");
  });

  it("offers both values of a boolean argument", () => {
    const { textarea } = renderComposer("/stop clear:");

    const rows = document.querySelectorAll('[role="option"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("true");
    expect(rows[1]).toHaveTextContent("false");

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea).toHaveValue("/stop clear:true");
  });

  it("runs a command whose arguments are optional when Enter is pressed", () => {
    const { textarea, onSend } = renderComposer("/stop ");

    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("/stop", undefined);
  });

  it("fills the argument a command cannot run without", () => {
    const { textarea, onSend } = renderComposer("/image ");

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("/image prompt:");
  });

  it("takes a typed argument name on Enter", () => {
    const { textarea } = renderComposer("/stop cl");

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea).toHaveValue("/stop clear:");
  });

  it("closes the menu once a choice is written out, so Enter sends", () => {
    const { textarea, onSend } = renderComposer("/stfu time:permanent");

    expect(document.querySelector('[role="listbox"]')).toBeNull();

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("/stfu time:permanent", undefined);
  });

  it("sends a filled-in command verbatim", () => {
    const { textarea, onSend, onCommand } = renderComposer(
      "/image prompt:a red fox size:1536x1024",
    );

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("/image prompt:a red fox size:1536x1024", undefined);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("opens the file picker from the files row", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const utils = renderComposer("/edit ");

    const row = argumentRow(utils, "files");
    expect(row).toBeTruthy();
    fireEvent.click(row!);

    expect(click).toHaveBeenCalled();
    // The picker does not eat the composer's text.
    expect(utils.textarea).toHaveValue("/edit ");
    click.mockRestore();
  });

  it("says how many pictures are attached", () => {
    const utils = renderComposer("/edit ");

    fireEvent.change(utils.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["x"], "photo.png", { type: "image/png" })] },
    });

    expect(argumentRow(utils, "files")).toHaveTextContent("1 attached");
  });
});
