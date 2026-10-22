/**
 * Pi operations backed by a sandbox workspace.
 *
 * Commands go to the `sandbox-exec` service; files are read and written
 * directly, because the volume is mounted at the same path on both sides. That
 * split is the point: reading a file needs no round trip, and the round trip
 * only exists where a process really has to run.
 *
 * File paths are confined twice: textually against the workspace root, then
 * through `realpath` inside the provider, so a symlink a tenant creates cannot
 * reach another tenant's directory.
 */

import type {
  BashOperations,
  EditOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { detectImageMimeTypeFromBuffer } from "@/lib/image-sniff";
import { createLocalFileProvider } from "@/lib/files/local-provider";
import { FileNotFoundError, FilePathEscapeError } from "@/lib/files/errors";
import { requireWithinRoot } from "@/lib/files/paths";
import type { FileProvider } from "@/lib/files/provider";
import { kill, exec as sandboxExec } from "./client";
import { WORKSPACE_TMP_DIR, workspaceOwner } from "./workspace";

export interface SandboxOperationsOptions {
  /** The workspace every command and every path belongs to. */
  identity: string;
  /** Absolute workspace root. */
  root: string;
  /** Variables injected into every command (the user's, resolved per session). */
  env?: Record<string, string> | undefined;
}

export interface SandboxOperations {
  bash: BashOperations;
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
}

/** The provider serves the workspace with the same hardening the browser gets. */
export function createWorkspaceProvider(root: string): FileProvider {
  return createLocalFileProvider({ root, owner: workspaceOwner() });
}

export function createSandboxOperations(options: SandboxOperationsOptions): SandboxOperations {
  const { identity, root, env } = options;
  const files = createWorkspaceProvider(root);

  const inside = (path: string): string => {
    try {
      return requireWithinRoot(root, path);
    } catch (err) {
      if (!(err instanceof FilePathEscapeError)) throw err;
      throw new Error(
        `${err.message}. Write scratch files under ${WORKSPACE_TMP_DIR}/ in the working directory: they are emptied automatically.`,
      );
    }
  };

  async function readFileOp(absolutePath: string): Promise<Buffer> {
    const bytes = await files.read(inside(absolutePath));
    return Buffer.from(bytes.buffer);
  }

  async function accessOp(absolutePath: string): Promise<void> {
    const path = inside(absolutePath);
    if ((await files.stat(path)) === null) {
      throw new Error(`ENOENT: no such file or directory, access '${absolutePath}'`);
    }
  }

  const bash: BashOperations = {
    exec: async (command, requestedCwd, context) => {
      const { onData, signal, timeout } = context;

      // Pi hands us the session cwd, which is the workspace; anything else is
      // an app path that means nothing inside the container.
      const cwd =
        requestedCwd && (requestedCwd === root || requestedCwd.startsWith(`${root}/`))
          ? requestedCwd
          : root;

      // The timeout comes from the model's tool arguments, so a negative or
      // non-finite value must not arm a deadline that expires instantly.
      const timeoutSeconds =
        typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
          ? timeout
          : undefined;

      let exitCode: number | null = null;

      try {
        for await (const event of sandboxExec({
          identity,
          command,
          cwd,
          ...(env && Object.keys(env).length > 0 ? { env } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
          ...(signal ? { signal } : {}),
        })) {
          if (event.type === "chunk") onData(event.data);
          if (event.type === "exit") {
            if (event.timedOut) throw new Error(`timeout:${timeoutSeconds}`);
            exitCode = event.exitCode;
          }
        }
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        throw err;
      }

      return { exitCode };
    },
  };

  const read: ReadOperations = {
    readFile: readFileOp,
    access: accessOp,
    detectImageMimeType: async (absolutePath) => {
      try {
        const bytes = await files.read(inside(absolutePath));
        return detectImageMimeTypeFromBuffer(Buffer.from(bytes.buffer)) ?? null;
      } catch (err) {
        if (err instanceof FileNotFoundError) return null;
        console.error(`Failed to sniff ${absolutePath}:`, err);
        return null;
      }
    },
  };

  const write: WriteOperations = {
    writeFile: async (absolutePath, content) => {
      await files.write(inside(absolutePath), Buffer.from(content));
    },
    mkdir: async (dir) => {
      await files.createDirectory(inside(dir));
    },
  };

  const edit: EditOperations = {
    readFile: readFileOp,
    writeFile: async (absolutePath, content) => {
      await files.write(inside(absolutePath), Buffer.from(content));
    },
    access: accessOp,
  };

  return { bash, read, write, edit };
}

/** Kill a running command (exported for callers that hold an exec id). */
export { kill as killSandboxExec };
