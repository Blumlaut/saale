// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { InputBar } from "@/components/chat/input-bar";
import { MessageList } from "@/components/chat/message-list";
import type { Message } from "@/components/chat/types";

// jsdom has no object URLs  stub the pair the InputBar uses for previews.
beforeEach(() => {
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn((file: File) => `blob:fake-${file.name}`),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeUserMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    role: "user",
    content: "",
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: "2025-01-01T00:00:00Z",
    attachments: undefined,
    ...overrides,
  };
}

// ─── InputBar: pasting and attaching files ───────────────────────────────────

describe("InputBar file attachment", () => {
  /**
   * The composer text is owned by the parent (it is the persisted draft), so
   * tests drive it through the controlled props exactly like ChatInterface.
   */
  function renderInputBar(props: { onSend: (message: string, files?: File[]) => void }) {
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <InputBar
          onSend={props.onSend}
          value={value}
          onValueChange={setValue}
          isLoading={false}
          onStop={() => {}}
        />
      );
    }
    return render(<Harness />);
  }

  function pasteFile(textarea: HTMLElement, file: File) {
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => file }],
        getData: () => "",
      },
    });
  }

  it("adds a pasted image as a preview and sends it with the message", async () => {
    const onSend = vi.fn();
    const image = new File([new Uint8Array([1])], "photo.png", { type: "image/png" });
    const { container } = renderInputBar({ onSend });

    const textarea = container.querySelector("textarea")!;
    pasteFile(textarea, image);

    // Image files render as a thumbnail preview
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("alt")).toBe("photo.png");
    expect(URL.createObjectURL).toHaveBeenCalledWith(image);

    fireEvent.change(textarea, { target: { value: "look at this" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });

    // The File is handed to onSend and the strip is cleared
    expect(onSend).toHaveBeenCalledWith("look at this", [image]);
    expect(container.querySelector("img")).toBeNull();
  });

  it("adds a pasted non-image file as a chip with name and size", () => {
    const onSend = vi.fn();
    const csv = new File([new Uint8Array(2048)], "data.csv", { type: "text/csv" });
    const { container } = renderInputBar({ onSend });

    const textarea = container.querySelector("textarea")!;
    pasteFile(textarea, csv);

    // No image preview for non-images
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
  });

  it("ignores plain text pastes (only kind === 'file' creates attachments)", () => {
    const onSend = vi.fn();
    const { container } = renderInputBar({ onSend });

    const textarea = container.querySelector("textarea")!;
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: "string", getAsFile: () => null }],
        getData: () => "plain text",
      },
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
});

// ─── MessageList: attachment rendering ───────────────────────────────────────

describe("MessageList attachments", () => {
  it("renders a non-image attachment as a downloadable chip", () => {
    const message = makeUserMessage({
      content: "check this out",
      attachments: [
        {
          id: "att-1",
          storageId: "att-real-1",
          fileName: "report.pdf",
          mimeType: "application/pdf",
          size: 1536,
        },
      ],
    });

    render(<MessageList messages={[message]} />);

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();

    // The chip fetches the file itself rather than navigating to it: on Firefox
    // for Android a download navigation leaves the custom tab on about:blank.
    fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));
    const [frame] = [...document.body.querySelectorAll("iframe")];
    expect(frame?.getAttribute("src")).toBe("/api/chat/attachments/att-real-1");
    expect(frame?.hidden).toBe(true);
  });

  it("renders a temp (in-flight) attachment as a muted chip without a download control", () => {
    const message = makeUserMessage({
      content: "sending",
      attachments: [
        {
          id: "att-2",
          storageId: "temp-file-1",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 42,
        },
      ],
    });

    render(<MessageList messages={[message]} />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Download / })).toBeNull();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it("keeps image attachments as <img> elements", () => {
    const message = makeUserMessage({
      content: "look",
      attachments: [
        {
          id: "att-3",
          storageId: "att-real-3",
          fileName: "photo.png",
          mimeType: "image/png",
          size: 1000,
          width: 100,
          height: 50,
        },
      ],
    });

    const { container } = render(<MessageList messages={[message]} />);

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/chat/attachments/att-real-3");
    expect(screen.queryByRole("link", { name: "Download photo.png" })).toBeNull();
  });
});
