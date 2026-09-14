// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueuedMessages } from "@/components/chat/queued-messages";
import type { Message } from "@/components/chat/types";

/**
 * The queue strip is the only place a waiting message is visible, so it has to
 * show every entry and route each action to the right message.
 */

function queued(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    role: "user",
    content: "queued text",
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: "2026-01-01T00:00:00Z",
    attachments: undefined,
    ...overrides,
  };
}

const noop = async () => {};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QueuedMessages", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = render(
      <QueuedMessages messages={[]} onEdit={noop} onSendNow={noop} onCancel={noop} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("lists every queued message in order", () => {
    render(
      <QueuedMessages
        messages={[
          queued({ id: "msg-1", content: "first" }),
          queued({ id: "msg-2", content: "second" }),
          queued({ id: "msg-3", content: "third" }),
        ]}
        onEdit={noop}
        onSendNow={noop}
        onCancel={noop}
      />,
    );

    expect(screen.getByText("Queued · 3")).toBeInTheDocument();
    const texts = screen.getAllByTitle(/first|second|third/).map((el) => el.textContent);
    expect(texts).toEqual(["first", "second", "third"]);
  });

  it("shows an attachment count for queued files", () => {
    render(
      <QueuedMessages
        messages={[
          queued({
            attachments: [
              {
                id: "att-1",
                storageId: "att-real-1",
                fileName: "report.pdf",
                mimeType: "application/pdf",
                size: 10,
              },
            ],
          }),
        ]}
        onEdit={noop}
        onSendNow={noop}
        onCancel={noop}
      />,
    );

    expect(screen.getByText(/1 file/)).toBeInTheDocument();
  });

  it("sends the pushed message now", async () => {
    const onSendNow = vi.fn().mockResolvedValue(undefined);
    render(
      <QueuedMessages
        messages={[queued({ id: "msg-7" })]}
        onEdit={noop}
        onSendNow={onSendNow}
        onCancel={noop}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send this message now" }));
    });

    expect(onSendNow).toHaveBeenCalledWith("msg-7");
  });

  it("cancels the message it belongs to", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(
      <QueuedMessages
        messages={[queued({ id: "msg-1" }), queued({ id: "msg-2", content: "second" })]}
        onEdit={noop}
        onSendNow={noop}
        onCancel={onCancel}
      />,
    );

    const cancelButtons = screen.getAllByRole("button", { name: "Cancel queued message" });
    await act(async () => {
      fireEvent.click(cancelButtons[1]!);
    });

    expect(onCancel).toHaveBeenCalledWith("msg-2");
  });

  it("edits a message inline and saves the new text", async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined);
    render(
      <QueuedMessages
        messages={[queued({ id: "msg-1", content: "typo here" })]}
        onEdit={onEdit}
        onSendNow={noop}
        onCancel={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    const textarea = screen.getByRole("textbox", { name: "Edit queued message" });
    expect(textarea).toHaveValue("typo here");

    fireEvent.change(textarea, { target: { value: "fixed" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(onEdit).toHaveBeenCalledWith("msg-1", "fixed");
  });

  it("abandons an edit on Escape without touching the message", async () => {
    const onEdit = vi.fn();
    render(
      <QueuedMessages
        messages={[queued({ id: "msg-1", content: "keep me" })]}
        onEdit={onEdit}
        onSendNow={noop}
        onCancel={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit queued message" }), {
      key: "Escape",
    });

    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByText("keep me")).toBeInTheDocument();
  });

  it("disables the send-now button for the message being pushed", () => {
    render(
      <QueuedMessages
        messages={[queued({ id: "msg-1" })]}
        sendingId="msg-1"
        onEdit={noop}
        onSendNow={noop}
        onCancel={noop}
      />,
    );

    expect(screen.getByRole("button", { name: "Send this message now" })).toBeDisabled();
  });
});
