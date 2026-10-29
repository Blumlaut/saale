// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalView } from "@/components/coder/terminal-view";

/**
 * The terminal panel.
 *
 * Driven through its own UI: a command goes out on one request, the answer
 * arrives on the chat's run stream, and the next keystroke is addressed to that
 * command. Leaving the panel changes nothing about the command, so a mount of
 * the panel is also a mount of the run that is already there.
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

/** The idle chat's run stream: open, with nothing to show. */
function emptyStream(): Response {
  return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** The run the terminal route hands back when a command starts. */
function startedRun(command: string, execId: string | null = null) {
  return json({
    run: {
      command,
      startedAt: 1,
      status: execId ? "running" : "starting",
      execId,
      exitCode: null,
      error: null,
    },
  });
}

const fetchMock = vi.fn();

/** Calls to one of the terminal endpoints. */
function callsTo(suffix: string): Array<[string, RequestInit | undefined]> {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith(suffix)) as Array<
    [string, RequestInit | undefined]
  >;
}

function bodyOf(call: [string, RequestInit | undefined]): Record<string, unknown> {
  return JSON.parse(call[1]!.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(emptyStream());
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
    let streams = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal/stream")) {
        streams += 1;
        // The panel mounted on an idle chat, then on the run it just started.
        return streams === 1
          ? emptyStream()
          : sseResponse([
              frame("command", { command: "echo hello", startedAt: 1 }),
              frame("started", { execId: "exec-1" }),
              frame("data", { stream: "stdout", text: "hello\n" }),
              frame("data", { stream: "stderr", text: "careful\n" }),
              frame("exit", { exitCode: 0, timedOut: false, durationMs: 1200 }),
            ]);
      }
      return startedRun("echo hello");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("echo hello"));

    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    expect(screen.getByText(/\$ echo hello/)).toBeInTheDocument();
    expect(screen.getByText(/careful/)).toBeInTheDocument();
    expect(screen.getByText(/^exit 0/)).toBeInTheDocument();

    const started = callsTo("/terminal");
    expect(started).toHaveLength(1);
    expect(started[0]![1]?.method).toBe("POST");
    expect(bodyOf(started[0]!)).toEqual({ command: "echo hello" });
  });

  it("shows a run that was already going when the panel opened", async () => {
    fetchMock.mockImplementation(async () =>
      sseResponse(
        [
          frame("command", { command: "npm run dev", startedAt: 1 }),
          frame("started", { execId: "exec-9" }),
          frame("data", { stream: "stdout", text: "listening on 5173\n" }),
        ],
        { hold: true },
      ),
    );
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    await waitFor(() => expect(screen.getByText(/listening on 5173/)).toBeInTheDocument());
    expect(screen.getByText(/\$ npm run dev/)).toBeInTheDocument();
    // Still running: the panel offers to stop it, and no command was sent.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(callsTo("/terminal")).toHaveLength(0);
  });

  it("types into the command that is still running", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal/input")) return json({ written: 2 });
      if (String(url).endsWith("/terminal/stream")) {
        return callsTo("/terminal").length === 0
          ? emptyStream()
          : sseResponse(
              [
                frame("command", { command: "npm init", startedAt: 1 }),
                frame("started", { execId: "exec-1" }),
              ],
              { hold: true },
            );
      }
      return startedRun("npm init");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("npm init"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    act(() => type("yes"));

    await waitFor(() => expect(callsTo("/terminal/input")).toHaveLength(1));
    expect(bodyOf(callsTo("/terminal/input")[0]!)).toEqual({ execId: "exec-1", data: "yes\n" });
  });

  it("sends a ctrl-c to the running command", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal/input")) return json({});
      if (String(url).endsWith("/terminal/stream")) {
        return callsTo("/terminal").length === 0
          ? emptyStream()
          : sseResponse(
              [
                frame("command", { command: "sleep 100", startedAt: 1 }),
                frame("started", { execId: "exec-1" }),
              ],
              { hold: true },
            );
      }
      return startedRun("sleep 100");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("sleep 100"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    const input = screen.getByLabelText("Terminal command");
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });

    await waitFor(() => expect(callsTo("/terminal/input")).toHaveLength(1));
    expect(bodyOf(callsTo("/terminal/input")[0]!)).toEqual({ execId: "exec-1", data: "\u0003" });
  });

  it("stops the command through the endpoint that owns it", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/terminal/stop")) return json({ stopped: true });
      if (String(url).endsWith("/terminal/stream")) {
        return callsTo("/terminal").length === 0
          ? emptyStream()
          : sseResponse(
              [
                frame("command", { command: "npm run dev", startedAt: 1 }),
                frame("started", { execId: "exec-1" }),
              ],
              { hold: true },
            );
      }
      if (init?.method === "POST") return startedRun("npm run dev");
      return emptyStream();
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("npm run dev"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    act(() => fireEvent.click(screen.getByRole("button", { name: "Stop" })));

    await waitFor(() => expect(callsTo("/terminal/stop")).toHaveLength(1));
  });

  it("shows the reason a command could not start", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal")) {
        return json({ error: "This chat has no worktree yet." }, 409);
      }
      return emptyStream();
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("ls"));

    // Once in the output, once under the input: the panel says why it stopped.
    await waitFor(() => expect(screen.getAllByText(/no worktree yet/)).toHaveLength(2));
  });

  it("keeps what earlier commands printed", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal/stream")) {
        return callsTo("/terminal").length === 0
          ? emptyStream()
          : sseResponse(
              callsTo("/terminal").length === 1
                ? [
                    frame("command", { command: "ls", startedAt: 1 }),
                    frame("data", { stream: "stdout", text: "a.txt\n" }),
                    frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
                  ]
                : [
                    frame("command", { command: "pwd", startedAt: 2 }),
                    frame("data", { stream: "stdout", text: "/worktrees/c-1a2b3c4d\n" }),
                    frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
                  ],
            );
      }
      return startedRun("ls");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("ls"));
    await waitFor(() => expect(screen.getByText(/a\.txt/)).toBeInTheDocument());

    act(() => type("pwd"));
    await waitFor(() => expect(screen.getByText(/worktrees\/c-1a2b3c4d/)).toBeInTheDocument());

    expect(screen.getByText(/\$ ls/)).toBeInTheDocument();
    expect(screen.getByText(/a\.txt/)).toBeInTheDocument();
  });

  it("answers a prompt with an empty line", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal/input")) return json({ written: 1 });
      if (String(url).endsWith("/terminal/stream")) {
        return callsTo("/terminal").length === 0
          ? emptyStream()
          : sseResponse(
              [
                frame("command", { command: "npm init", startedAt: 1 }),
                frame("started", { execId: "exec-1" }),
              ],
              { hold: true },
            );
      }
      return startedRun("npm init");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("npm init"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    act(() => fireEvent.keyDown(screen.getByLabelText("Terminal command"), { key: "Enter" }));

    await waitFor(() => expect(callsTo("/terminal/input")).toHaveLength(1));
    expect(bodyOf(callsTo("/terminal/input")[0]!)).toEqual({ execId: "exec-1", data: "\n" });
  });

  it("leaves a selection in the output alone", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal/stream")) {
        return sseResponse([
          frame("command", { command: "git log", startedAt: 1 }),
          frame("data", { stream: "stdout", text: "commit 1a2b3c4d\n" }),
          frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
        ]);
      }
      return startedRun("git log");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("git log"));
    const output = await screen.findByText(/commit 1a2b3c4d/);

    const range = document.createRange();
    range.selectNodeContents(output);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const input = screen.getByLabelText("Terminal command") as HTMLInputElement;
    act(() => input.blur());
    act(() => fireEvent.click(output));

    expect(document.activeElement).not.toBe(input);
    expect(selection.toString()).toContain("commit 1a2b3c4d");

    // A plain click still puts the caret back in the prompt.
    act(() => selection.removeAllRanges());
    act(() => fireEvent.click(output));
    expect(document.activeElement).toBe(input);
  });

  it("walks back through what was run", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal/stream")) {
        return sseResponse(
          [
            frame("command", { command: "git status", startedAt: 1 }),
            frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
          ],
          { hold: false },
        );
      }
      return startedRun("git status");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);
    const input = screen.getByLabelText("Terminal command") as HTMLInputElement;

    act(() => type("git status"));
    await waitFor(() => expect(screen.getAllByText(/^exit 0/).length).toBeGreaterThan(0));
    act(() => type("npm test"));
    await waitFor(() => expect(callsTo("/terminal")).toHaveLength(2));

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
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/terminal") && init?.method === "DELETE") {
        return json({ cleared: true });
      }
      if (String(url).endsWith("/terminal/stream")) {
        return callsTo("/terminal").length === 0
          ? emptyStream()
          : sseResponse([
              frame("command", { command: "ls", startedAt: 1 }),
              frame("data", { stream: "stdout", text: "noise\n" }),
              frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
            ]);
      }
      return startedRun("ls");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("ls"));
    await waitFor(() => expect(screen.getByText(/noise/)).toBeInTheDocument());

    act(() => fireEvent.click(screen.getByRole("button", { name: "Clear the terminal" })));

    expect(screen.queryByText(/noise/)).toBeNull();
    await waitFor(() =>
      expect(callsTo("/terminal").filter((call) => call[1]?.method === "DELETE")).toHaveLength(1),
    );
    const input = screen.getByLabelText("Terminal command") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("ls");
  });
});
