/**
 * A council's file sandbox.
 *
 * The sandbox *is* the council's workspace directory and the container that
 * mounts only it. Every file and every command a member runs is inside that
 * one directory, and the other tenants' directories are absent from the
 * container entirely, so the built-in tools (`read`, `write`, `edit`, `bash`)
 * are safe here without being crippled.
 *
 * Two things are added on top of `createSandboxOperations`:
 *
 * - **Path confinement.** The container is the boundary, but the tool arguments
 *   still come from a model: a path is normalized and refused when it leaves the
 *   sandbox, so app-side paths (the uploads volume, `/etc`, another tenant's
 *   workspace) never reach the filesystem.
 * - **A preflight.** `ensureCouncilSandbox` creates the directory and asks the
 *   service for its health, so a run fails before the first turn rather than
 *   halfway through one.
 *
 * Concurrent writers need no lock here: Pi's `write` and `edit` already
 * serialize same-path mutations process-wide (`withFileMutationQueue`). A file
 * written from `bash` is not covered by that, and members are expected to
 * coordinate through the room.
 */

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { createSandboxOperations } from "@/lib/sandbox/operations";
import * as sandboxClient from "@/lib/sandbox/client";
import { ensureWorkspace, removeWorkspace } from "@/lib/sandbox/workspace";
import { resolveWithinRoot } from "@/lib/files/paths";
import { sandboxIdentity, type CouncilSandboxIdentity } from "./accounts";

/** Raised when a tool argument points outside the council's sandbox. */
export class CouncilSandboxEscapeError extends Error {
  constructor(requested: string) {
    super(
      `Path is outside the council sandbox and was refused: ${requested}. ` +
        `Work inside the sandbox. paths are relative to it.`,
    );
    this.name = "CouncilSandboxEscapeError";
  }
}

/**
 * Resolve `path` inside `root`.
 *
 * The rule. collapse, pop `..`, refuse anything that is not the root or under
 * it. is shared with the file browser (`@/lib/files/paths`), so a member's tool
 * argument and a browser request can never be judged by two different
 * implementations. `inside` is false when the result leaves the root.
 */
export function resolveSandboxPath(root: string, path: string): { path: string; inside: boolean } {
  return resolveWithinRoot(root, path);
}

/** {@link resolveSandboxPath}, refusing anything that leaves the root. */
export function normalizeSandboxPath(root: string, path: string): string {
  const resolved = resolveSandboxPath(root, path);
  if (!resolved.inside) throw new CouncilSandboxEscapeError(path);
  return resolved.path;
}

export interface CouncilSandbox {
  identity: CouncilSandboxIdentity;
  /** The sandbox root: the council's directory in the volume. */
  home: string;
  operations: {
    read: ReadOperations;
    write: WriteOperations;
    edit: EditOperations;
    bash: BashOperations;
  };
}

/**
 * The operations a council member's file tools run through.
 *
 * `env` is the council owner's variables: members act for the owner, and a
 * member has no variables of its own to leak.
 */
export function createCouncilSandbox(options: {
  councilId: string;
  sandboxKey: string;
  env?: Record<string, string> | undefined;
}): CouncilSandbox {
  const identity = sandboxIdentity(options.sandboxKey);
  const home = identity.path;

  const base = createSandboxOperations({
    identity: identity.id,
    root: home,
    env: options.env,
  });

  const inside = (path: string): string => normalizeSandboxPath(home, path);

  /**
   * A cwd that stays in the sandbox. `bash` needs one to run in, and refusing
   * the command outright would leave the model with a tool that cannot run at
   * all. the root is the only safe answer for a cwd that points outside.
   */
  const clampCwd = (requested: string | undefined): string => {
    if (!requested) return home;
    const resolved = resolveSandboxPath(home, requested);
    return resolved.inside ? resolved.path : home;
  };

  // Every wrapper is `async` on purpose: a path the guard refuses must reject
  // the returned promise, not throw before the caller's promise exists.
  const read: ReadOperations = {
    readFile: async (absolutePath) => base.read.readFile(inside(absolutePath)),
    access: async (absolutePath) => base.read.access(inside(absolutePath)),
    detectImageMimeType: async (absolutePath) =>
      (await base.read.detectImageMimeType?.(inside(absolutePath))) ?? null,
  };

  const write: WriteOperations = {
    writeFile: async (absolutePath, content) => base.write.writeFile(inside(absolutePath), content),
    mkdir: async (dir) => base.write.mkdir(inside(dir)),
  };

  const edit: EditOperations = {
    readFile: async (absolutePath) => base.edit.readFile(inside(absolutePath)),
    writeFile: async (absolutePath, content) => base.edit.writeFile(inside(absolutePath), content),
    access: async (absolutePath) => base.edit.access(inside(absolutePath)),
  };

  const bash: BashOperations = {
    exec: (command, requestedCwd, context) =>
      base.bash.exec(command, clampCwd(requestedCwd), context),
  };

  return { identity, home, operations: { read, write, edit, bash } };
}

/**
 * The council's built-in file tools, bound to its sandbox.
 *
 * Built from Pi's own tool factories so truncation, image handling, exact-match
 * editing and diffing stay in the SDK. the sandbox only supplies the backend.
 * `bash` uses the `AgentTool` form, which drops Pi's TUI renderers.
 */
export function councilSandboxTools(sandbox: CouncilSandbox): {
  read: ToolDefinition;
  write: ToolDefinition;
  edit: ToolDefinition;
  bash: ToolDefinition;
} {
  const { home, operations } = sandbox;
  return {
    read: createReadTool(home, { operations: operations.read }),
    write: createWriteTool(home, { operations: operations.write }),
    edit: createEditTool(home, { operations: operations.edit }),
    bash: createBashTool(home, { operations: operations.bash }),
  };
}

/**
 * Create the sandbox directory and check the service is reachable.
 *
 * Runs before the first turn: a member that discovers halfway through that its
 * workspace is unavailable has already spent the owner's money on a turn it
 * cannot act on. The per-container mount check is the service's job and runs
 * when the container is created.
 */
export async function ensureCouncilSandbox(identity: CouncilSandboxIdentity): Promise<void> {
  if (!sandboxClient.isConfigured()) {
    throw new Error("Council sandboxes need the sandbox service (SANDBOX_URL)");
  }

  await ensureWorkspace(identity.id);
  await sandboxClient.health();
}

/**
 * Remove the sandbox container and its directory.
 *
 * Best-effort and never throws: a council that is being deleted must not stay
 * behind because the service was briefly unreachable, but a cleanup that did
 * not happen is reported. a sandbox left on disk holds the members' work.
 */
export async function destroyCouncilSandbox(identity: CouncilSandboxIdentity): Promise<void> {
  if (sandboxClient.isConfigured()) {
    try {
      await sandboxClient.removeContainer(identity.id);
    } catch (err) {
      console.warn(`[council] Could not remove the sandbox container ${identity.id}:`, err);
    }
  }

  try {
    await removeWorkspace(identity.id);
  } catch (err) {
    console.error(`[council] Could not remove the sandbox directory ${identity.path}:`, err);
  }
}
