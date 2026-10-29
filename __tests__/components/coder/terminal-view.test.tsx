// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The terminal panel.
 *
 * Driven through its own UI: a command goes out on one request, the answer
 * arrives on the chat's run stream, and the next keystroke is addressed to that
 * command. The terminal itself is a canvas, so it is stood in for here and the
 * test reads what the panel writes into it.
 */

const terminal = vi.hoisted(() => ({
  /** Everything the panel wrote, in order. */
  writes: [] as string[],
  /** What the terminal holds on screen, for the panel's clear button. */
  resets: 0,
  /** Whether the user has a selection in the output. */
  selection: false,
  cols: 100,
  rows: 30,
}));

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    // Live, so a test can play the part of a panel that was dragged wider.
    get cols(): number {
      return terminal.cols;
    }
    get rows(): number {
      return terminal.rows;
    }
    options: Record<string, unknown> = {};
    loadAddon(): void {}
    open(): void {}
    dispose(): void {}
    write(text: string): void {
      terminal.writes.push(text);
    }
    reset(): void {
      terminal.writes.length = 0;
      terminal.resets += 1;
    }
    hasSelection(): boolean {
      return terminal.selection;
    }
  }
  return { Terminal: FakeTerminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate(): void {}
    dispose(): void {}
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: terminal.cols, rows: terminal.rows };
    }
  },
}));

import { TerminalView } from "@/components/coder/terminal-view";

const WORKTREE = { path: "worktrees/saale/c-1a2b3c4d", branch: "wt/c-1a2b3c4d" };

/** Everything written into the terminal, in order. */
function written(): string {
  return terminal.writes.join("");
}

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
      cols: 100,
      rows: 30,
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

/** A command that is running and waiting for input. */
function holdRunning(command = "npm init"): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith("/terminal/input")) return json({ written: 1 });
    if (String(url).endsWith("/terminal/stream")) {
      return callsTo("/terminal").length === 0
        ? emptyStream()
        : sseResponse(
            [frame("command", { command, startedAt: 1 }), frame("started", { execId: "exec-1" })],
            { hold: true },
          );
    }
    return startedRun(command);
  });
}

beforeEach(() => {
  terminal.writes = [];
  terminal.resets = 0;
  terminal.selection = false;
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
              frame("data", { stream: "stdout", text: "hello\r\n" }),
              frame("data", { stream: "stdout", text: "\u001b[31mcareful\u001b[0m\r\n" }),
              frame("exit", { exitCode: 0, timedOut: false, durationMs: 1200 }),
            ]);
      }
      return startedRun("echo hello");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("echo hello"));

    await waitFor(() => expect(written()).toContain("hello\r\n"));
    expect(written()).toContain("$ echo hello");
    // Escape codes go to the terminal untouched: it is what draws them.
    expect(written()).toContain("\u001b[31mcareful\u001b[0m");
    expect(written()).toContain("exit 0");

    const started = callsTo("/terminal");
    expect(started).toHaveLength(1);
    expect(started[0]![1]?.method).toBe("POST");
    // The run starts at the size the panel fitted the terminal to.
    expect(bodyOf(started[0]!)).toEqual({ command: "echo hello", cols: 100, rows: 30 });
  });

  it("shows a run that was already going when the panel opened", async () => {
    fetchMock.mockImplementation(async () =>
      sseResponse(
        [
          frame("command", { command: "npm run dev", startedAt: 1 }),
          frame("started", { execId: "exec-9" }),
          frame("data", { stream: "stdout", text: "listening on 5173\r\n" }),
        ],
        { hold: true },
      ),
    );
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    await waitFor(() => expect(written()).toContain("listening on 5173"));
    expect(written()).toContain("$ npm run dev");
    // Still running: the panel offers to stop it, and no command was sent.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(callsTo("/terminal")).toHaveLength(0);
  });

  it("sends each character to the command as it is typed", async () => {
    holdRunning();
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("npm init"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    const input = screen.getByLabelText("Terminal command") as HTMLInputElement;
    act(() => fireEvent.change(input, { target: { value: "y" } }));
    act(() => fireEvent.change(input, { target: { value: "es" } }));
    act(() => fireEvent.keyDown(input, { key: "Enter" }));

    await waitFor(() => expect(callsTo("/terminal/input")).toHaveLength(3));
    expect(callsTo("/terminal/input").map((call) => bodyOf(call))).toEqual([
      { execId: "exec-1", data: "y" },
      { execId: "exec-1", data: "es" },
      { execId: "exec-1", data: "\r" },
    ]);
    // The prompt row stays empty: the terminal shows what the command echoes.
    expect(input.value).toBe("");
  });

  it("sends an arrow key as the bytes a terminal would", async () => {
    holdRunning("less");
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("less"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    act(() => fireEvent.keyDown(screen.getByLabelText("Terminal command"), { key: "ArrowDown" }));

    await waitFor(() => expect(callsTo("/terminal/input")).toHaveLength(1));
    expect(bodyOf(callsTo("/terminal/input")[0]!)).toEqual({ execId: "exec-1", data: "\u001b[B" });
  });

  it("sends a ctrl-c to the running command", async () => {
    holdRunning("sleep 100");
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("sleep 100"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    fireEvent.keyDown(screen.getByLabelText("Terminal command"), { key: "c", ctrlKey: true });

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

    // Once in the terminal, once under the prompt: the panel says why it stopped.
    await waitFor(() => expect(written()).toContain("This chat has no worktree yet."));
    expect(screen.getByText(/no worktree yet/)).toBeInTheDocument();
  });

  it("writes a second command after the first, keeping the scrollback", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal/stream")) {
        return callsTo("/terminal").length === 0
          ? emptyStream()
          : sseResponse(
              callsTo("/terminal").length === 1
                ? [
                    frame("command", { command: "ls", startedAt: 1 }),
                    frame("data", { stream: "stdout", text: "a.txt\r\n" }),
                    frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
                  ]
                : [
                    frame("command", { command: "pwd", startedAt: 2 }),
                    frame("data", { stream: "stdout", text: "/worktrees/c-1a2b3c4d\r\n" }),
                    frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
                  ],
            );
      }
      return startedRun("ls");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("ls"));
    await waitFor(() => expect(written()).toContain("a.txt"));

    act(() => type("pwd"));
    await waitFor(() => expect(written()).toContain("/worktrees/c-1a2b3c4d"));

    // Nothing is wiped: the terminal keeps what came before.
    expect(written()).toContain("$ ls");
    expect(written()).toContain("a.txt");
    expect(terminal.resets).toBe(0);
  });

  it("tells a run that is going about a resize", async () => {
    const observers: Array<() => void> = [];
    class FakeResizeObserver {
      constructor(private readonly callback: () => void) {
        observers.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    holdRunning("top");
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("top"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument());

    terminal.cols = 140;
    terminal.rows = 44;
    act(() => {
      for (const notify of observers) notify();
    });

    await waitFor(() => expect(callsTo("/terminal/resize")).toHaveLength(1));
    expect(bodyOf(callsTo("/terminal/resize")[0]!)).toEqual({ cols: 140, rows: 44 });
    vi.unstubAllGlobals();
    terminal.cols = 100;
    terminal.rows = 30;
  });

  it("keeps a selection in the output, and the focus with it", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal/stream")) {
        return sseResponse([
          frame("command", { command: "git log", startedAt: 1 }),
          frame("data", { stream: "stdout", text: "commit 1a2b3c4d\r\n" }),
          frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
        ]);
      }
      return startedRun("git log");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("git log"));
    await waitFor(() => expect(written()).toContain("commit 1a2b3c4d"));

    const input = screen.getByLabelText("Terminal command") as HTMLInputElement;
    const output = screen.getByLabelText("Terminal output");
    act(() => input.blur());

    terminal.selection = true;
    act(() => fireEvent.click(output));
    expect(document.activeElement).not.toBe(input);

    // A plain click still puts the caret back in the prompt.
    terminal.selection = false;
    act(() => fireEvent.click(output));
    expect(document.activeElement).toBe(input);
  });

  it("walks back through what was run", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/terminal/stream")) {
        return sseResponse([
          frame("command", { command: "git status", startedAt: 1 }),
          frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
        ]);
      }
      return startedRun("git status");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);
    const input = screen.getByLabelText("Terminal command") as HTMLInputElement;

    act(() => type("git status"));
    await waitFor(() => expect(written()).toContain("exit 0"));
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

  it("clears the screen and keeps the history", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/terminal") && init?.method === "DELETE") {
        return json({ cleared: true });
      }
      if (String(url).endsWith("/terminal/stream")) {
        return callsTo("/terminal").length === 0
          ? emptyStream()
          : sseResponse([
              frame("command", { command: "ls", startedAt: 1 }),
              frame("data", { stream: "stdout", text: "noise\r\n" }),
              frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
            ]);
      }
      return startedRun("ls");
    });
    render(<TerminalView sessionId="chat-1" worktree={WORKTREE} />);

    act(() => type("ls"));
    await waitFor(() => expect(written()).toContain("noise"));

    act(() => fireEvent.click(screen.getByRole("button", { name: "Clear the terminal" })));

    expect(written()).not.toContain("noise");
    expect(terminal.resets).toBe(1);
    await waitFor(() =>
      expect(callsTo("/terminal").filter((call) => call[1]?.method === "DELETE")).toHaveLength(1),
    );
    const input = screen.getByLabelText("Terminal command") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("ls");
  });
});
