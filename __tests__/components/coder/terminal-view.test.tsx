// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalView } from "@/components/coder/terminal-view";

/**
 * The terminal panel.
 *
 * Driven through its own UI: a command goes out on one request, the answer is
 * read as it streams, and the next keystroke is addressed to that command.
 */

const WORKTREE = { path: "worktrees/saale/c-1a2b3c4d", branch: "wt/c-1a2b3c4d" };

/** A response whose body drips the given SSE frames. */
function sseResponse(frames: string[], options: { hold?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (!options.hold) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const fetchMock = vi.fn();

function bodyOf(call: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[call]![1].body as string) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function type(command: string): void {
  const input = screen.getByLabelText("Terminal command");
  fireEvent.change(input, { target: { value: command } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("TerminalView", () => {
  it("says what is missing before the chat has a worktree", () => {
    render(<TerminalView sessionId="chat-1" worktree={null} />);

    expect(screen.queryByLabelText("Terminal command")).toBeNull();
    expect(screen.getByText(/the terminal opens in it/)).toBeInTheDocument();
  });

  it("runs a command, shows its output and its exit code", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        frame("started", { execId: "exec-1" }),
        frame("data", { type: "data", stream: "stdout", text: "hello\n" }),
        frame("data", { type: "data", stream: "stderr", text: "careful\n" }),
        frame("exit", { type: "exit", exitCode: 0, timedOut: false, durationMs: 1200 }),
      ]),
    );
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("echo hello"));

    await waitFor(() => expect(screen.getByText(/hello/)).toBeInTheDocument());
    expect(screen.getByText(/\$ echo hello/)).toBeInTheDocument();
    expect(screen.getByText(/careful/)).toBeInTheDocument();
    expect(screen.getByText(/exit 0/)).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/coder/sessions/chat-1/terminal",
      expect.objectContaining({ method: "POST" }),
    );
    expect(bodyOf(0)).toEqual({ command: "echo hello" });
  });

  it("types into the command that is still running", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/terminal/input")) {
        return new Response(JSON.stringify({ written: 2 }), { status: 200 });
      }
      // Announces the command and stays open, the way a prompt does.
      return sseResponse([frame("started", { execId: "exec-1" })], { hold: true });
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("npm init"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    act(() => type("yes"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/coder/sessions/chat-1/terminal/input");
    expect(bodyOf(1)).toEqual({ execId: "exec-1", data: "yes\n" });
  });

  it("sends a ctrl-c to the running command", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/terminal/input")) return new Response("{}", { status: 200 });
      return sseResponse([frame("started", { execId: "exec-1" })], { hold: true });
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("sleep 100"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    const input = screen.getByLabelText("Terminal command");
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(1)).toEqual({ execId: "exec-1", data: "\u0003" });
  });

  it("shows the reason a command could not start", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "This chat has no worktree yet." }), { status: 409 }),
    );
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("ls"));

    // Once in the output, once under the input: the panel says why it stopped.
    await waitFor(() => expect(screen.getAllByText(/no worktree yet/)).toHaveLength(2));
  });

  it("walks back through what was run", async () => {
    fetchMock.mockImplementation(async () =>
      sseResponse([frame("exit", { type: "exit", exitCode: 0, durationMs: 1 })]),
    );
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);
    const input = screen.getByLabelText("Terminal command") as HTMLInputElement;

    act(() => type("git status"));
    await waitFor(() => expect(screen.getByText(/exit 0/)).toBeInTheDocument());
    act(() => type("npm test"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("npm test");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("git status");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("npm test");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("");
  });

  it("clears the output and keeps the history", async () => {
    fetchMock.mockImplementation(async () =>
      sseResponse([
        frame("data", { type: "data", stream: "stdout", text: "noise\n" }),
        frame("exit", { type: "exit", exitCode: 0, durationMs: 1 }),
      ]),
    );
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("ls"));
    await waitFor(() => expect(screen.getByText(/noise/)).toBeInTheDocument());

    act(() => fireEvent.click(screen.getByRole("button", { name: "Clear the terminal" })));

    expect(screen.queryByText(/noise/)).toBeNull();
    const input = screen.getByLabelText("Terminal command") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("ls");
  });
});
