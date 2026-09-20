import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/terminal/client", () => ({
  executeCommand: vi.fn(),
  getCommandStatus: vi.fn(),
  killCommand: vi.fn(),
  readFile: vi.fn(),
  readFileBinary: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
}));

import * as terminal from "@/lib/terminal/client";
import { createTerminalOperations } from "@/lib/terminal/operations";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function status(partial: Partial<terminal.ExecuteResult> = {}): terminal.ExecuteResult {
  return {
    id: "proc-1",
    command: "echo hi",
    status: "running",
    exit_code: null,
    output: [],
    truncated: false,
    next_offset: 0,
    ...partial,
  };
}

const COMMON = { userId: "user-1", sessionId: "sess-1" };

function setup() {
  const ops = createTerminalOperations({ ...COMMON, cwd: "/home/user" });
  vi.mocked(terminal.executeCommand).mockResolvedValue(status());
  return ops;
}

// ─── bash.exec ───────────────────────────────────────────────────────────────

describe("terminal bash operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams output and returns the exit code on success", async () => {
    const ops = setup();
    vi.mocked(terminal.getCommandStatus).mockResolvedValue(
      status({ status: "done", exit_code: 0, output: ["hello\n"] }),
    );

    const chunks: Buffer[] = [];
    const result = await ops.bash.exec("echo hi", "/home/user", {
      onData: (data) => chunks.push(data),
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello\n");
  });

  it("passes through a null exit code from the container (e.g. signal-killed)", async () => {
    const ops = setup();
    vi.mocked(terminal.getCommandStatus).mockResolvedValue(
      status({ status: "killed", exit_code: null }),
    );

    const result = await ops.bash.exec("killme", "/home/user", { onData: () => {} });

    expect(result).toEqual({ exitCode: null });
  });

  it("returns null exit code when the container cleaned up the process (404)", async () => {
    const ops = setup();
    vi.mocked(terminal.getCommandStatus).mockRejectedValue(new Error("404 Not Found"));

    const result = await ops.bash.exec("ls", "/home/user", { onData: () => {} });

    expect(result).toEqual({ exitCode: null });
  });

  it("throws timeout:<secs> when the deadline passes, after force-killing the command", async () => {
    vi.useFakeTimers();
    try {
      const ops = setup();
      // Long poll that overshoots the 1s deadline
      vi.mocked(terminal.getCommandStatus).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(status()), 1100)),
      );

      const promise = ops.bash.exec("sleep 10", "/home/user", {
        onData: () => {},
        timeout: 1,
      });
      const assertion = expect(promise).rejects.toThrow("timeout:1");
      await vi.advanceTimersByTimeAsync(1500);

      await assertion;
      expect(terminal.killCommand).toHaveBeenCalledWith("proc-1", {
        ...COMMON,
        force: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws aborted when the signal aborts, after killing the command", async () => {
    vi.useFakeTimers();
    try {
      const ops = setup();
      const controller = new AbortController();
      vi.mocked(terminal.getCommandStatus).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(status()), 100)),
      );

      const promise = ops.bash.exec("sleep 10", "/home/user", {
        onData: () => {},
        signal: controller.signal,
      });
      const assertion = expect(promise).rejects.toThrow("aborted");

      // First poll resolves; the loop starts a second poll before the abort
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);

      await assertion;
      expect(terminal.killCommand).toHaveBeenCalledWith("proc-1", COMMON);
    } finally {
      vi.useRealTimers();
    }
  });
});
