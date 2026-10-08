// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "@/components/chat/message-list";
import type { Message } from "@/components/chat/types";

beforeAll(() => {
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = vi.fn();
});

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: "assistant",
    content: "",
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: "2026-01-01T12:00:00.000Z",
    attachments: undefined,
    ...overrides,
  };
}

describe("MessageList provider errors", () => {
  it("renders a failed turn that has no content (previously invisible)", () => {
    render(
      <MessageList
        messages={[
          message({ id: "u1", role: "user", content: "count the tokens" }),
          message({
            id: "a1",
            content: "",
            errorMessage: '400: {"message":"Invalid max_tokens value"}',
          }),
        ]}
      />,
    );

    expect(screen.getByText("Provider error")).toBeInTheDocument();
    expect(screen.getByText("Invalid max_tokens value")).toBeInTheDocument();
  });

  it("shows the error next to the partial text of a mid-stream failure", () => {
    render(
      <MessageList
        messages={[
          message({
            id: "a1",
            content: "Here is the first half",
            errorMessage: "503: service unavailable",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Here is the first half")).toBeInTheDocument();
    expect(screen.getByText("service unavailable")).toBeInTheDocument();
  });

  it("still renders ordinary turns without an error notice", () => {
    render(<MessageList messages={[message({ id: "a1", content: "All good" })]} />);

    expect(screen.getByText("All good")).toBeInTheDocument();
    expect(screen.queryByText("Provider error")).not.toBeInTheDocument();
  });

  it("replaces the thinking indicator with retry progress during a backoff", () => {
    render(
      <MessageList
        messages={[message({ id: "u1", role: "user", content: "hi" })]}
        isLoading
        retry={{ attempt: 2, maxAttempts: 3, errorMessage: "429: rate limit exceeded" }}
      />,
    );

    expect(screen.getByText(/retrying \(2 of 3\)/)).toBeInTheDocument();
    expect(screen.getByText(/rate limit exceeded/)).toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  it("shows no inline working indicator when no retry is in flight", () => {
    // Waiting on the LLM or a tool result is covered by the composer's stop
    // button — the transcript must not duplicate it with a spinner of its own.
    render(
      <MessageList messages={[message({ id: "u1", role: "user", content: "hi" })]} isLoading />,
    );

    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.queryByText("Provider error")).not.toBeInTheDocument();
  });
});
