/**
 * A council's file sandbox.
 *
 * The sandbox *is* the council's Open Terminal account (see `accounts.ts`): its
 * home directory, and the identity every command and file operation runs as.
 * Unix permissions are the boundary — the account cannot read the user's home,
 * and the user cannot read the sandbox — which is why the same three built-in
 * tools a chat uses (`read`, `write`, `edit`, `bash`) are safe here without
 * being crippled.
 *
 * Two things are added on top of `createTerminalOperations`:
 *
 * - **Path confinement.** The account is the boundary, but the tool arguments
 *   still come from a model: a path is normalized and refused when it leaves the
 *   sandbox, so app-side paths (the uploads volume, `/etc`, another tenant's
 *   workspace) never reach the container. Textual, so a symlink can still point
 *   out of the sandbox and be followed — the account's permissions are what stop
 *   that from reading anything it should not.
 * - **The mode check.** `ensureCouncilSandbox` verifies the container really
 *   mapped the sandbox key to its own account before anything runs. Without
 *   `OPEN_TERMINAL_MULTI_USER=true` Open Terminal ignores `X-User-Id` and every
 *   command would run as the user — the opposite of a sandbox — so it refuses
 *   instead.
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
import { createTerminalOperations } from "@/lib/terminal/operations";
import { isConfigured } from "@/lib/terminal/client";
import { resolveWithinRoot } from "@/lib/files/paths";
import { sandboxIdentity, type CouncilSandboxIdentity } from "./accounts";
import { isSafeAccountName, runContainerCommand, runTerminalCommand } from "./commands";

/** Raised when a tool argument points outside the council's sandbox. */
export class CouncilSandboxEscapeError extends Error {
  constructor(requested: string) {
    super(
      `Path is outside the council sandbox and was refused: ${requested}. ` +
        `Work inside the sandbox — paths are relative to it.`,
    );
    this.name = "CouncilSandboxEscapeError";
  }
}

/**
 * Resolve `path` inside `root`.
 *
 * The rule — collapse, pop `..`, refuse anything that is not the root or under
 * it — is shared with the file browser (`@/lib/files/paths`), so a member's tool
 * argument and a browser request can never be judged by two different
 * implementations. `inside` is false when the result leaves the root.
 */
export function resolveSandboxPath(root: string, path: string): { path: string; inside: boolean } {
  return resolveWithinRoot(root, path);
}

/**
 * Resolve `path` inside `root`, refusing anything that leaves it.
 *
 * The account is the boundary; this is what stops a tool argument from reaching
 * app-side paths (the uploads volume, `/etc`, another tenant's workspace) in the
 * first place. Textual, so a symlink can still point out of the sandbox and be
 * followed — the account's own permissions are what stop *that* from reading
 * anything it should not.
 */
export function normalizeSandboxPath(root: string, path: string): string {
  const resolved = resolveSandboxPath(root, path);
  if (!resolved.inside) throw new CouncilSandboxEscapeError(path);
  return resolved.path;
}

export interface CouncilSandbox {
  identity: CouncilSandboxIdentity;
  /** The sandbox root: the account's home directory. */
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
 * `sessionId` is the council's, not a member's: the sandbox account is shared by
 * every member (that is the point), and the terminal session it names only
 * affects the cwd Open Terminal remembers — every call here passes an explicit
 * cwd or an absolute, already-resolved path.
 */
export function createCouncilSandbox(options: {
  councilId: string;
  sandboxKey: string;
  userId: string;
}): CouncilSandbox {
  const identity = sandboxIdentity(options.sandboxKey);
  const home = identity.home;
  const terminalSessionId = `council-sandbox-${options.councilId}`;

  const base = createTerminalOperations({
    userId: identity.key,
    sessionId: terminalSessionId,
    cwd: home,
  });

  const inside = (path: string): string => normalizeSandboxPath(home, path);

  /**
   * A cwd that stays in the sandbox. `bash` needs one to run in, and refusing
   * the command outright would leave the model with a tool that cannot run at
   * all — the root is the only safe answer for a cwd that points outside.
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
 * editing and diffing stay in the SDK — the sandbox only supplies the backend.
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
 * An id that Open Terminal maps to the *same* account as `key`.
 *
 * Its username is the first eight alphanumeric characters of the id, so an id
 * that begins with the key resolves to the same account while being a different
 * id to the container (which caches ids).
 */
function sameAccountIdentityKey(key: string): string {
  return `${key}0`;
}

/**
 * Create the sandbox account and verify it is one.
 *
 * Runs `id -un` as the sandbox identity, which is also what makes Open Terminal
 * provision the account on first use. The answer must be the account derived
 * from the key: anything else means `X-User-Id` was ignored and the command ran
 * as the user's own identity, so the "sandbox" would be the user's home. That is
 * refused rather than run.
 *
 * The retry covers a container-side detail with teeth: Open Terminal caches
 * `X-User-Id → account` in memory, and its cache says "already provisioned"
 * without re-checking `/etc/passwd`. An account that was deleted (a council
 * being cleaned up) is therefore remembered as existing, and every command for
 * that id fails with `sudo: unknown user` — permanently, since the cache lives
 * as long as the container. Asking under an id that resolves to the *same*
 * account is a different cache entry, so the container provisions it again; the
 * original id then works too.
 */
export async function ensureCouncilSandbox(identity: CouncilSandboxIdentity): Promise<void> {
  if (!isConfigured()) {
    throw new Error("Council sandboxes need the Open Terminal integration (OPEN_TERMINAL_API_KEY)");
  }
  if (!isSafeAccountName(identity.account)) {
    throw new Error(`Refusing to provision an unsafe account name: ${identity.account}`);
  }

  const probe = (userId: string) =>
    runTerminalCommand("id -un", {
      userId,
      sessionId: `council-sandbox-${identity.key}`,
      cwd: identity.home,
      waitSeconds: 60,
    });

  let result = await probe(identity.key);
  if (result.exitCode !== 0) {
    const retry = await probe(sameAccountIdentityKey(identity.key));
    if (retry.exitCode === 0) {
      console.warn(
        `[council] Sandbox ${identity.account} needed re-provisioning (the container had it cached).`,
      );
      result = retry;
    }
  }

  const { exitCode, output } = result;
  if (exitCode !== 0) {
    throw new Error(
      `Could not start the council sandbox account ${identity.account}: ${output.trim() || "no output"}`,
    );
  }

  const account = output.trim().split("\n").pop()?.trim() ?? "";
  if (account !== identity.account) {
    throw new Error(
      `Council sandboxes require OPEN_TERMINAL_MULTI_USER=true — the sandbox identity resolved to ` +
        `"${account}" instead of "${identity.account}", so it would run in the user's workspace.`,
    );
  }
}

/**
 * Remove the sandbox account and its home directory.
 *
 * Best-effort and never throws: a council that is being deleted must not stay
 * behind because the container was briefly unreachable, but a cleanup that did
 * not happen is reported — a sandbox left on disk holds the members' work.
 *
 * The fallback `rm -rf` exists because `userdel -r` refuses while a process of
 * that account is still running (a member's shell, a killed turn). The account
 * itself cannot be removed from inside a member's session — that needs the
 * container's own identity, which is what runs this.
 */
export async function destroyCouncilSandbox(identity: CouncilSandboxIdentity): Promise<void> {
  if (!isConfigured()) return;
  if (!isSafeAccountName(identity.account)) {
    throw new Error(`Refusing to delete an unsafe account name: ${identity.account}`);
  }

  const account = identity.account;
  const removal = await runContainerCommand(`sudo userdel -r ${account} 2>&1`);
  if (removal.exitCode !== 0) {
    console.warn(
      `[council] userdel ${account} did not complete (${removal.exitCode}): ${removal.output.trim()}`,
    );
    const wipe = await runContainerCommand(`sudo rm -rf /home/${account} 2>&1`);
    if (wipe.exitCode !== 0) {
      console.error(
        `[council] Could not wipe the sandbox home of ${account}: ${wipe.output.trim()}`,
      );
    }
  }

  // The container's own account is added to a new account's group so it can read
  // the workspace natively; that membership outlives the account and would keep
  // the group alive, so it is dropped before the group is.
  const demote = await runContainerCommand(`sudo gpasswd -d user ${account} 2>&1`);
  if (demote.exitCode !== 0) {
    console.warn(
      `[council] Could not drop the container account from group ${account}: ${demote.output.trim()}`,
    );
  }
  const group = await runContainerCommand(`sudo groupdel ${account} 2>&1`);
  if (group.exitCode !== 0) {
    console.warn(`[council] Could not delete group ${account}: ${group.output.trim()}`);
  }
}
