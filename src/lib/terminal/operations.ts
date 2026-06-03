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
import * as terminal from "./client";

/**
 * Detect image MIME type by reading magic bytes from a buffer.
 * Matches Pi's internal detectSupportedImageMimeTypeFromFile behavior.
 */
function detectImageMimeTypeFromBuffer(data: Buffer): string | null {
  // JPEG: FF D8 FF (skip FF D8 FF F7 special variant)
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return data[3] === 0xf7 ? null : "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A + valid IHDR chunk
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length >= 16 && PNG_SIG.every((b, i) => (data[i] ?? 0) === b)) {
    const chunkLen =
      ((data[8] ?? 0) << 24) | ((data[9] ?? 0) << 16) | ((data[10] ?? 0) << 8) | (data[11] ?? 0);
    if (
      chunkLen === 13 &&
      (data[12] ?? 0) === 0x49 &&
      (data[13] ?? 0) === 0x48 &&
      (data[14] ?? 0) === 0x44 &&
      (data[15] ?? 0) === 0x52
    ) {
      return "image/png";
    }
    return null;
  }

  // GIF: starts with ASCII "GIF"
  if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return "image/gif";
  }

  // WebP: "RIFF" then "WEBP" at offset 8
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

/**
 * Poll a running command until it finishes or the signal/timeout fires.
 * Streams output chunks via onData as they arrive.
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

  while (!signal?.aborted) {
    // Check deadline
    if (deadline && Date.now() > deadline) {
      try {
        await terminal.killCommand(processId, { userId, sessionId, force: true });
      } catch {
        // Ignore kill errors on timeout
      }
      return { exitCode: null };
    }

    const remaining = deadline
      ? Math.max(1, Math.floor((deadline - Date.now()) / 1000))
      : undefined;

    let status: terminal.ExecuteResult;
    try {
      status = await terminal.getCommandStatus(processId, {
        userId,
        sessionId,
        offset,
        wait: remaining ?? 5,
      });
    } catch (err: unknown) {
      // Process may have cleaned up
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404")) {
        return { exitCode: null };
      }
      throw err;
    }

    // Stream new output
    if (Array.isArray(status.output)) {
      for (const entry of status.output) {
        const text = typeof entry === "string" ? entry : (entry.data ?? "");
        if (text) {
          onData(Buffer.from(text, "utf8"));
        }
      }
    }

    offset = status.next_offset ?? offset;

    // Process finished
    if (status.status !== "running") {
      exitCode = status.exit_code;
      break;
    }
  }

  // Handle abort
  if (signal?.aborted) {
    try {
      await terminal.killCommand(processId, { userId, sessionId });
    } catch {
      // Ignore
    }
    return { exitCode: null };
  }

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
  const { userId, sessionId, cwd } = opts;
  const common: TerminalCommon = { userId, sessionId };

  return {
    // ─── Bash ───────────────────────────────────────────────────────────

    bash: {
      exec: async (command, _cwd, { onData, signal, timeout, env }) => {
        // Use the factory cwd (user home), not the per-call cwd
        const execBody: Record<string, unknown> = { command };
        if (cwd) execBody.cwd = cwd;
        if (env) execBody.env = env as Record<string, string>;

        const result = await terminal.executeCommand(command, {
          ...common,
          cwd,
          ...(env ? { env: env as Record<string, string> } : {}),
          wait: 0, // Don't wait — we poll manually
        });

        return pollCommand(result.id, userId, sessionId, {
          onData,
          ...(signal ? { signal } : {}),
          ...(timeout ? { timeout } : {}),
        });
      },
    },

    // ─── Read ───────────────────────────────────────────────────────────

    read: {
      readFile: async (absolutePath) => {
        const result = await terminal.readFile(absolutePath, common);
        if ("buffer" in result) {
          return result.buffer;
        }
        return Buffer.from(result.content, "utf8");
      },
      access: async (absolutePath) => {
        // Probe by reading via the view endpoint
        try {
          await terminal.readFileBinary(absolutePath, common);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404")) {
            throw new Error(`ENOENT: no such file or directory, access '${absolutePath}'`);
          }
          throw err;
        }
      },
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
      readFile: async (absolutePath) => {
        const result = await terminal.readFile(absolutePath, common);
        if ("buffer" in result) {
          return result.buffer;
        }
        return Buffer.from(result.content, "utf8");
      },
      writeFile: async (absolutePath, content) => {
        await terminal.writeFile(absolutePath, content, common);
      },
      access: async (absolutePath) => {
        try {
          await terminal.readFileBinary(absolutePath, common);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404")) {
            throw new Error(`ENOENT: no such file or directory, access '${absolutePath}'`);
          }
          throw err;
        }
      },
    },
  };
}
