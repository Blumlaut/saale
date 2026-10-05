/**
 * Pi SDK operations backed by Open Terminal.
 *
 * Implements BashOperations, ReadOperations, WriteOperations, and EditOperations
 * by delegating to the Open Terminal REST API. This gives the Pi SDK's built-in
 * tools (with truncation, image rendering, diff previews, etc.) a sandboxed
 * execution backend.
 */

import type {
  BashOperations,
  EditOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { detectImageMimeTypeFromBuffer } from "@/lib/image-sniff";
import * as terminal from "./client";

/**
 * A command the user's shell would report as killed by a signal: the POSIX
 * convention is 128 + signal number (SIGTERM → 143), which Python's
 * `subprocess` reports as a negative return code (-15).
 */
function normalizeExitCode(exitCode: number | null): number | null {
  return exitCode !== null && exitCode < 0 ? 128 - exitCode : exitCode;
}

/**
 * Poll a running command until it finishes or the signal/timeout fires.
 * Streams output chunks via onData as they arrive.
 *
 * Failure signaling (consumed by the Pi bash tool, which appends captured
 * output before the message):
 * - timeout → throws `timeout:<secs>`  → "Command timed out after N seconds"
 * - abort   → throws `aborted`         → "Command aborted"
 * - a null exit code (e.g. the container cleaned up the process) is passed
 *   through and reported by the tool as "Command terminated without an exit
 *   code" — pi v0.86 treats null as a failure, not partial success.
 */
async function pollCommand(
  processId: string,
  userId: string,
  sessionId: string,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
  },
): Promise<{ exitCode: number | null }> {
  const { onData, signal, timeout } = options;
  let offset = 0;
  let exitCode: number | null = null;

  const deadline = timeout ? Date.now() + timeout * 1000 : undefined;

  const kill = async (force: boolean, reason: string) => {
    try {
      await terminal.killCommand(processId, {
        userId,
        sessionId,
        ...(force ? { force: true } : {}),
      });
    } catch (err) {
      console.error(`Failed to kill command ${reason}:`, err);
    }
  };

  /**
   * Abort handling. A poll can sit in a `wait` window of up to 5s, so waiting
   * for the next iteration to notice the signal would leave the command
   * running — and the run waiting — for that whole window. The command is
   * killed immediately (force: a Stop means stop) and the in-flight poll is
   * raced against the signal so the run continues at once.
   */
  let notifyAborted: (() => void) | null = null;
  const aborted = new Promise<void>((resolve) => {
    notifyAborted = resolve;
  });
  const onAbort = () => {
    void kill(true, "on abort");
    notifyAborted?.();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!signal?.aborted) {
      // Check deadline
      if (deadline && Date.now() > deadline) {
        await kill(true, "on timeout");
        throw new Error(`timeout:${timeout}`);
      }

      const remaining = deadline
        ? Math.max(1, Math.floor((deadline - Date.now()) / 1000))
        : undefined;

      // Both arms are handled, so a poll that loses the race (or rejects after
      // the abort) cannot surface as an unhandled rejection.
      const polled = terminal
        .getCommandStatus(processId, { userId, sessionId, offset, wait: remaining ?? 5 })
        .then(
          (value) => ({ outcome: "status" as const, value }),
          (error: unknown) => ({ outcome: "error" as const, error }),
        );
      const result = await Promise.race([
        polled,
        aborted.then(() => ({ outcome: "aborted" as const })),
      ]);

      if (result.outcome === "aborted") {
        throw new Error("aborted");
      }
      if (result.outcome === "error") {
        // The container dropped the process (e.g. it was cleaned up or the
        // session was restarted) — reported as "terminated without an exit code".
        if (result.error instanceof terminal.TerminalApiError && result.error.status === 404) {
          return { exitCode: null };
        }
        throw result.error;
      }

      const status = result.value;

      // Stream new output
      if (Array.isArray(status.output)) {
        for (const entry of status.output) {
          const text =
            typeof entry === "string" ? entry : typeof entry?.data === "string" ? entry.data : "";
          if (!text) {
            // An entry we cannot read is output the model will never see.
            console.error("Unexpected Open Terminal output entry:", JSON.stringify(entry));
            continue;
          }
          onData(Buffer.from(text, "utf8"));
        }
      } else if (status.output !== undefined) {
        console.error("Unexpected Open Terminal output payload:", typeof status.output);
      }

      // Output beyond the container's buffer was dropped, so say so instead of
      // presenting a partial log as complete.
      if (status.truncated) {
        onData(
          Buffer.from(
            "\n[output truncated by the terminal — earlier output was dropped]\n",
            "utf8",
          ),
        );
      }

      offset = status.next_offset ?? offset;

      // Process finished
      if (status.status !== "running") {
        exitCode = normalizeExitCode(status.exit_code);
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  // The loop only gets here after the command finished (an abort throws above).
  return { exitCode };
}

// ─── Factory ────────────────────────────────────────────────────────────────

interface TerminalOperationsOptions {
  /** Saale user ID — used for multi-user isolation. */
  userId: string;
  /** Pi session ID — used for cwd persistence across tool calls. */
  sessionId: string;
  /** Base working directory (user's home in the container). */
  cwd: string;
  /** Extra environment variables injected into every command (e.g. GH_TOKEN). */
  extraEnv?: Record<string, string> | undefined;
}

type TerminalCommon = { userId: string; sessionId: string };

/**
 * Create all Pi SDK operations backed by Open Terminal.
 */
export function createTerminalOperations(opts: TerminalOperationsOptions): {
  bash: BashOperations;
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
} {
  const { userId, sessionId, cwd, extraEnv } = opts;
  const common: TerminalCommon = { userId, sessionId };

  /**
   * Environment for every command: our explicit extras only.
   *
   * The SDK hands `BashOperations.exec` the *server's* environment
   * (`{...process.env}`, see `resolveSpawnContext` in the SDK's bash tool) so a
   * local shell has a PATH. Forwarding it to a remote terminal would ship
   * DATABASE_URL, the encryption key and the terminal API key into the
   * container, where any command the model runs can read them. Open Terminal
   * merges what we send into the container's own environment, so the
   * container's PATH/HOME survive and only GH_TOKEN (when configured) is added.
   */
  const commandEnv = extraEnv;

  // ── Shared helpers (used by both read and edit operations) ──

  async function readFileOp(absolutePath: string): Promise<Buffer> {
    const result = await terminal.readFile(absolutePath, common);
    if ("buffer" in result) {
      return result.buffer;
    }
    return Buffer.from(result.content, "utf8");
  }

  async function accessOp(absolutePath: string): Promise<void> {
    try {
      await terminal.readFileBinary(absolutePath, common);
    } catch (err: unknown) {
      if (err instanceof terminal.TerminalApiError && err.status === 404) {
        throw new Error(`ENOENT: no such file or directory, access '${absolutePath}'`);
      }
      throw err;
    }
  }

  return {
    // ─── Bash ───────────────────────────────────────────────────────────

    bash: {
      exec: async (command, requestedCwd, { onData, signal, timeout }) => {
        // Pi hands us its own cwd, which is a host-side path (the Pi session
        // directory) and does not exist in the container. Only a path inside
        // the container's home is meaningful; anything else falls back to
        // `cwd`, the user's home — the directory the file tools use as well.
        const callCwd = requestedCwd && requestedCwd.startsWith(cwd) ? requestedCwd : undefined;

        // The timeout comes from the model's tool arguments, so a negative or
        // non-finite value must not arm a deadline that expires instantly (or
        // never); anything unusable means "no timeout", the tool's own default.
        const timeoutSecs =
          typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
            ? timeout
            : undefined;

        const result = await terminal.executeCommand(command, {
          ...common,
          cwd: callCwd ?? cwd,
          ...(commandEnv ? { env: commandEnv } : {}),
          wait: 0, // Don't wait — we poll manually
        });

        return pollCommand(result.id, userId, sessionId, {
          onData,
          ...(signal ? { signal } : {}),
          ...(timeoutSecs ? { timeout: timeoutSecs } : {}),
        });
      },
    },

    // ─── Read ───────────────────────────────────────────────────────────

    read: {
      readFile: readFileOp,
      access: accessOp,
      detectImageMimeType: async (absolutePath) => {
        try {
          const result = await terminal.readFileBinary(absolutePath, common);
          return detectImageMimeTypeFromBuffer(result.buffer) ?? null;
        } catch {
          return null;
        }
      },
    },

    // ─── Write ──────────────────────────────────────────────────────────

    write: {
      writeFile: async (absolutePath, content) => {
        await terminal.writeFile(absolutePath, content, common);
      },
      mkdir: async (dir) => {
        await terminal.createDirectory(dir, common);
      },
    },

    // ─── Edit ───────────────────────────────────────────────────────────

    edit: {
      readFile: readFileOp,
      writeFile: async (absolutePath, content) => {
        await terminal.writeFile(absolutePath, content, common);
      },
      access: accessOp,
    },
  };
}
