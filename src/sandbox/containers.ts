/**
 * Container lifecycle and command execution.
 *
 * One container per identity, holding one directory of the workspaces volume.
 * Everything a caller can ask for is expressed with an identity: a directory, a
 * mount subpath, a container name and a working directory are all derived here,
 * so no request can name another tenant's tree.
 *
 * The Docker handle is injected and typed structurally so the behaviour can be
 * tested without a daemon: a fake records the create options and replays output
 * the same way a real exec does.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { PassThrough, type Duplex } from "node:stream";
import type Dockerode from "dockerode";
import type { SandboxConfig } from "@/lib/sandbox/config";
import { previewIdentitySlug } from "@/lib/preview/url";
import { isNotFoundError } from "@/lib/files/errors";
import { parseIdentity } from "@/lib/sandbox/identity";
import {
  containerName,
  containerSpec,
  containerWorkspacePath,
  limitDrift,
  wantedLimits,
  type ContainerLimits,
} from "@/lib/sandbox/spec";
import { ensureWorkspace, identityPath } from "@/lib/sandbox/workspace";
import { checkMountinfo } from "./mount-check";
import {
  createExecRegistry,
  ExecStdinClosedError,
  UnknownExecError,
  type ExecRegistry,
  type RunningExec,
} from "./registry";

/** The slice of a container this module uses. */
export interface ContainerHandle {
  id?: string;
  start(): Promise<unknown>;
  stop(options?: { t?: number }): Promise<unknown>;
  update(options: ContainerLimits): Promise<unknown>;
  remove(options?: { force?: boolean }): Promise<unknown>;
  inspect(): Promise<Dockerode.ContainerInspectInfo>;
  exec(options: Dockerode.ExecCreateOptions): Promise<ExecHandle>;
}

/** The slice of an exec this module uses. */
export interface ExecHandle {
  id: string;
  start(options?: Dockerode.ExecStartOptions): Promise<NodeJS.ReadableStream>;
  inspect(options?: Dockerode.ExecInspectOptions): Promise<Dockerode.ExecInspectInfo>;
  /** Set the pty's size. Only meaningful for an exec started with `Tty`. */
  resize(options: { h: number; w: number }): Promise<unknown>;
}

/** What one list call reports, as far as this module cares. */
export interface ContainerSummary {
  Id: string;
  Labels?: Record<string, string> | undefined;
  State?: string | undefined;
}

/** The Docker API surface, structural so a fake can stand in. */
export interface DockerHandle {
  getContainer(name: string): ContainerHandle;
  createContainer(options: Dockerode.ContainerCreateOptions): Promise<ContainerHandle>;
  listContainers(options: Dockerode.ContainerListOptions): Promise<ContainerSummary[]>;
  modem: {
    demuxStream(
      stream: NodeJS.ReadableStream,
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
    ): void;
  };
}

export interface SandboxExecRequest {
  command: string;
  /** Confined to the identity's directory. */
  cwd?: string | undefined;
  /** Variables for this command only. */
  env?: Record<string, string> | undefined;
  timeoutSeconds?: number | undefined;
  /** Attach stdin, so a caller can type into the command while it runs. */
  interactive?: boolean | undefined;
  /** Give the command a terminal of its own, which is what a TUI needs. */
  tty?: boolean | undefined;
  /** Terminal width, for `tty`. */
  cols?: number | undefined;
  /** Terminal height, for `tty`. */
  rows?: number | undefined;
}

export interface SandboxChunk {
  stream: "stdout" | "stderr";
  data: Buffer;
}

export interface SandboxExecResult {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export interface SandboxExecSession {
  id: string;
  result: Promise<SandboxExecResult>;
}

/** Raised for a request that cannot be carried out as asked. */
export class SandboxRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SandboxRequestError";
  }
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_ENV_VARS = 32;
const MAX_ENV_BYTES = 32 * 1024;
/** How long a stopped command gets to exit before it is killed outright. */
const KILL_GRACE_MS = 2000;
/** Terminal a pty exec gets when the caller names no size. */
const DEFAULT_TTY_COLS = 80;
const DEFAULT_TTY_ROWS = 24;
/** Widest and tallest a terminal may claim to be. */
export const MAX_TTY_DIMENSION = 1000;

/** A terminal dimension from a request, or the default. */
export function ttyDimension(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTY_DIMENSION) {
    throw new SandboxRequestError(`A terminal dimension is 1..${MAX_TTY_DIMENSION}`);
  }
  return value;
}
/** How long to wait for Docker to report an exit code after the stream ends. */
const EXIT_POLL_MS = 100;
const EXIT_POLL_TRIES = 50;

/** How long a slug lookup may reuse one container list. */
const SLUG_INDEX_TTL_MS = 10_000;

export interface ContainerManager {
  ensure(identity: string): Promise<ContainerHandle>;
  run(
    identity: string,
    request: SandboxExecRequest,
    onChunk: (chunk: SandboxChunk) => void,
  ): Promise<SandboxExecSession>;
  kill(id: string): Promise<void>;
  /** Type into a command that was started with `interactive`. */
  write(id: string, identity: string, data: Buffer): Promise<void>;
  /** Resize the terminal of a command that was started with `tty`. */
  resize(id: string, cols: number, rows: number): Promise<void>;
  /** Remove an identity's container. Its directory stays. */
  remove(identity: string): Promise<boolean>;
  stop(identity: string): Promise<boolean>;
  /**
   * Stop anything a previous process left behind, and remove the containers
   * whose workspace directory is no longer there (a renamed identity).
   */
  sweep(): Promise<{ stopped: number; removed: number }>;
  /** Stop idle containers, remove ones past their time to live. */
  reapIdle(): Promise<{ stopped: number; removed: number }>;
  /** The workspace a preview hostname's slug stands for, or null. */
  identityForSlug(slug: string): Promise<string | null>;
}

export interface ContainerManagerOptions {
  docker: DockerHandle;
  config: SandboxConfig;
  now?: (() => number) | undefined;
  registry?: ExecRegistry | undefined;
}

/** Variables as `KEY=value`, refusing anything the app should not have sent. */
export function envList(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const keys = Object.keys(env);
  if (keys.length > MAX_ENV_VARS) {
    throw new SandboxRequestError(`At most ${MAX_ENV_VARS} environment variables are allowed`);
  }

  let total = 0;
  const list: string[] = [];
  for (const key of keys) {
    if (!ENV_NAME.test(key))
      throw new SandboxRequestError(`Invalid environment variable name: ${key}`);
    const value = env[key] ?? "";
    if (value.includes("\0")) {
      throw new SandboxRequestError(`Environment variable ${key} contains a NUL byte`);
    }
    total += Buffer.byteLength(value, "utf8");
    list.push(`${key}=${value}`);
  }
  if (total > MAX_ENV_BYTES) {
    throw new SandboxRequestError(`Environment variables exceed ${MAX_ENV_BYTES} bytes`);
  }
  return list;
}

/** A working directory inside the identity's own directory, or the root. */
export function confineCwd(
  identity: string,
  cwd: string | undefined,
  config: SandboxConfig,
): string {
  const root = containerWorkspacePath(identity, config);
  if (!cwd) return root;
  const resolved = path.posix.resolve(cwd);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new SandboxRequestError(`Working directory is outside the workspace: ${cwd}`);
  }
  return resolved;
}

export function createContainerManager(options: ContainerManagerOptions): ContainerManager {
  const { docker, config } = options;
  const now = options.now ?? (() => Date.now());
  const registry = options.registry ?? createExecRegistry();
  /** Last time each identity ran something, for the idle reaper. */
  const lastUsed = new Map<string, number>();
  /** Timers waiting to SIGKILL a command that ignored SIGTERM. */
  const killTimers = new Map<string, NodeJS.Timeout>();
  /** Containers being brought up, so parallel commands share one start. */
  const starting = new Map<string, Promise<ContainerHandle>>();
  /** Slug to identity, rebuilt when it ages out or a container changes. */
  let slugIndex: { at: number; bySlug: Map<string, string> } | null = null;
  /** Identities already warned that their container's limits are stale. */
  const warnedDrift = new Set<string>();

  async function inspectOrNull(name: string): Promise<Dockerode.ContainerInspectInfo | null> {
    try {
      return await docker.getContainer(name).inspect();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** One short command in a container, its combined output as text. */
  async function capture(container: ContainerHandle, cmd: string[]): Promise<string> {
    const exec = await container.exec({
      Cmd: cmd,
      User: config.user,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    docker.modem.demuxStream(stream, stdout, stderr);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Signal a command's process group. */
  async function signalGroup(entry: RunningExec, signal: "TERM" | "KILL"): Promise<void> {
    const script =
      `p=$(cat ${entry.pgidFile} 2>/dev/null); ` +
      `if [ -n "$p" ]; then kill -${signal} -$p 2>/dev/null || kill -${signal} $p 2>/dev/null; fi`;
    const exec = await entry.container.exec({
      Cmd: ["sh", "-c", script],
      User: config.user,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    stream.resume();
    await new Promise<void>((resolve) => {
      stream.on("end", resolve);
      stream.on("error", () => resolve());
    });
  }

  async function waitForExitCode(exec: ExecHandle): Promise<number> {
    for (let attempt = 0; attempt < EXIT_POLL_TRIES; attempt += 1) {
      const info = await exec.inspect();
      if (!info.Running && typeof info.ExitCode === "number") return info.ExitCode;
      await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
    }
    // A command that never reports is reported as a failure rather than as
    // success: the caller cannot tell what happened.
    return 1;
  }

  /** Create the container, then require its mount view to be exactly right. */
  async function create(identity: string): Promise<ContainerHandle> {
    await ensureWorkspace(identity);
    const spec = containerSpec(identity, config);
    const container = await docker.createContainer({
      ...spec,
      HostConfig: spec.HostConfig as unknown as Dockerode.HostConfig,
    });

    try {
      await startOnce(container);
      const mountinfo = await capture(container, ["cat", "/proc/self/mountinfo"]);
      const check = checkMountinfo(mountinfo, { identity, workspacesDir: config.workspacesDir });
      if (!check.ok) {
        throw new SandboxRequestError(
          `Refusing container ${containerName(identity)}: ${check.reason}`,
          500,
        );
      }
    } catch (err) {
      try {
        await container.remove({ force: true });
      } catch (removeErr) {
        console.error(
          `Failed to remove container ${containerName(identity)} after a failed start:`,
          removeErr,
        );
      }
      throw err;
    }

    return container;
  }

  /** Docker answers 304 when the container is already up or being started. */
  async function startOnce(container: ContainerHandle): Promise<void> {
    try {
      await container.start();
    } catch (err) {
      if (!isAlreadyStarted(err)) throw err;
    }
  }

  async function startContainer(id: string): Promise<ContainerHandle> {
    const name = containerName(id);
    const existing = await inspectOrNull(name);

    if (existing) {
      const drift = limitDrift(existing.HostConfig, config);
      // Replacing a container mid-command would kill it, so a busy container
      // keeps its old limits until it falls idle.
      if (drift.length === 0) return resume(id, name, existing.State.Running);

      if (registry.idsFor(id).length > 0) {
        if (!warnedDrift.has(id)) {
          warnedDrift.add(id);
          console.warn(
            `[sandbox] container ${name} keeps its old limits while in use: ${drift.join(", ")}`,
          );
        }
        return resume(id, name, existing.State.Running);
      }

      // Limits are the daemon's to change on a live container, and it records
      // them on the container. Only a refusal costs the writable layer.
      if (await applyLimits(name, drift)) {
        warnedDrift.delete(id);
        return resume(id, name, existing.State.Running);
      }

      console.warn(`[sandbox] replacing container ${name}: ${drift.join(", ")}`);
      warnedDrift.delete(id);
      try {
        await docker.getContainer(name).remove({ force: true });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      slugIndex = null;
    }

    const container = await create(id);
    slugIndex = null;
    lastUsed.set(id, now());
    return container;
  }

  /** Hand the container back, started if it was stopped. */
  async function resume(id: string, name: string, running: boolean): Promise<ContainerHandle> {
    const container = docker.getContainer(name);
    if (!running) await startOnce(container);
    lastUsed.set(id, now());
    return container;
  }

  /** Put new limits on the running container; false when the daemon refused. */
  async function applyLimits(name: string, drift: string[]): Promise<boolean> {
    try {
      await docker.getContainer(name).update(wantedLimits(config));
    } catch (err) {
      console.error(`Failed to update limits on ${name} (${drift.join(", ")}):`, err);
      return false;
    }
    return true;
  }

  async function ensure(identity: string): Promise<ContainerHandle> {
    const id = parseIdentity(identity);
    const pending = starting.get(id);
    if (pending) return pending;

    const promise = startContainer(id).finally(() => starting.delete(id));
    starting.set(id, promise);
    return promise;
  }

  async function run(
    identity: string,
    request: SandboxExecRequest,
    onChunk: (chunk: SandboxChunk) => void,
  ): Promise<SandboxExecSession> {
    const id = parseIdentity(identity);
    if (!request.command.trim()) throw new SandboxRequestError("A command is required");
    const tty = request.tty === true;
    const interactive = tty || request.interactive === true;

    const container = await ensure(id);
    const execId = randomUUID();
    const pgidFile = `/tmp/.saale-${execId}.pgid`;
    const cwd = confineCwd(id, request.cwd, config);
    // $$ is the exec's own process group, which is what the stop path signals.
    const commandLine = `echo $$ > ${pgidFile}; exec bash -c "$1"`;

    const exec = await container.exec({
      Cmd: tty
        ? // A pty is already this exec's session: `setsid` would only detach
          // it, and the terminal's line discipline is what makes ctrl-c reach
          // the command.
          ["sh", "-c", commandLine, "sh", request.command]
        : [
            // `--wait` because setsid forks when the exec's process is already a
            // group leader: without it the exec reports setsid's own 0 and the
            // command's status is lost.
            "setsid",
            "--wait",
            "sh",
            "-c",
            commandLine,
            "sh",
            request.command,
          ],
      User: config.user,
      WorkingDir: cwd,
      Env: envList(request.env),
      AttachStdin: interactive,
      AttachStdout: true,
      // A pty carries one stream: stderr arrives on it too.
      AttachStderr: !tty,
      Tty: tty,
    });

    const stream = await exec.start({ hijack: true, stdin: interactive });
    if (tty) {
      await exec.resize({
        w: ttyDimension(request.cols, DEFAULT_TTY_COLS),
        h: ttyDimension(request.rows, DEFAULT_TTY_ROWS),
      });
    }
    const entry: RunningExec = {
      identity: id,
      pgidFile,
      container,
      exec,
      settled: false,
      ...(interactive ? { stdin: stream as Duplex } : {}),
    };
    registry.add(execId, entry);
    lastUsed.set(id, now());

    const startedAt = now();
    let timedOut = false;

    if (tty) {
      // Raw bytes off the pty: no docker framing to demux.
      stream.on("data", (data: Buffer) => onChunk({ stream: "stdout", data }));
    } else {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on("data", (data: Buffer) => onChunk({ stream: "stdout", data }));
      stderr.on("data", (data: Buffer) => onChunk({ stream: "stderr", data }));
      docker.modem.demuxStream(stream, stdout, stderr);
    }

    const ended = new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
      stream.on("close", resolve);
    });

    const timer = request.timeoutSeconds
      ? setTimeout(
          () => {
            timedOut = true;
            void kill(execId).catch((err) =>
              console.error(`Failed to stop command ${execId} on timeout:`, err),
            );
          },
          Math.max(0.001, request.timeoutSeconds) * 1000,
        )
      : null;

    const result = (async (): Promise<SandboxExecResult> => {
      try {
        await ended;
      } catch (err) {
        console.error(`Output stream for command ${execId} failed:`, err);
      }
      const exitCode = await waitForExitCode(exec);
      entry.settled = true;
      registry.delete(execId);
      if (timer) clearTimeout(timer);
      const pendingKill = killTimers.get(execId);
      if (pendingKill) {
        clearTimeout(pendingKill);
        killTimers.delete(execId);
      }
      lastUsed.set(id, now());
      return { exitCode, timedOut, durationMs: now() - startedAt };
    })();

    return { id: execId, result };
  }

  async function kill(execId: string): Promise<void> {
    const entry = registry.get(execId);
    if (!entry) throw new UnknownExecError(execId);
    if (entry.settled) return;

    await signalGroup(entry, "TERM");
    if (entry.settled || killTimers.has(execId)) return;

    const timer = setTimeout(() => {
      killTimers.delete(execId);
      if (!entry.settled) {
        void signalGroup(entry, "KILL").catch((err) =>
          console.error(`Failed to kill command ${execId}:`, err),
        );
      }
    }, KILL_GRACE_MS);
    timer.unref?.();
    killTimers.set(execId, timer);
  }

  /**
   * Write to a command's stdin.
   *
   * The socket is hijacked and duplex, so writes go straight to the process.
   * There is no EOF: Docker cannot half-close a hijacked connection, and
   * closing it would take the output down with it.
   */
  async function write(execId: string, identity: string, data: Buffer): Promise<void> {
    const entry = registry.get(execId);
    if (!entry || entry.identity !== parseIdentity(identity)) throw new UnknownExecError(execId);
    if (entry.settled) throw new UnknownExecError(execId);
    if (!entry.stdin) throw new ExecStdinClosedError(execId);
    if (data.length === 0) return;

    await new Promise<void>((resolve, reject) => {
      entry.stdin?.write(data, (err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Resize the terminal of a command started with `tty`. */
  async function resize(execId: string, cols: number, rows: number): Promise<void> {
    const entry = registry.get(execId);
    if (!entry || entry.settled) throw new UnknownExecError(execId);

    await entry.exec.resize({
      w: ttyDimension(cols, DEFAULT_TTY_COLS),
      h: ttyDimension(rows, DEFAULT_TTY_ROWS),
    });
  }

  async function stop(identity: string): Promise<boolean> {
    const id = parseIdentity(identity);
    const name = containerName(id);
    const existing = await inspectOrNull(name);
    if (!existing) return false;
    if (!existing.State.Running) return true;
    await docker.getContainer(name).stop({ t: 10 });
    lastUsed.delete(id);
    return true;
  }

  async function remove(identity: string): Promise<boolean> {
    const id = parseIdentity(identity);
    for (const execId of registry.idsFor(id)) {
      await kill(execId).catch((err) =>
        console.error(`Failed to stop ${execId} before removal:`, err),
      );
    }

    const name = containerName(id);
    const existing = await inspectOrNull(name);
    if (!existing) {
      lastUsed.delete(id);
      return false;
    }
    await docker.getContainer(name).remove({ force: true });
    slugIndex = null;
    lastUsed.delete(id);
    return true;
  }

  async function labelled(): Promise<
    Array<{ identity: string; container: ContainerHandle; summary: ContainerSummary }>
  > {
    const summaries = await docker.listContainers({
      all: true,
      filters: { label: ["saale.sandbox"] },
    });
    const rows: Array<{ identity: string; container: ContainerHandle; summary: ContainerSummary }> =
      [];
    for (const summary of summaries) {
      const identity = summary.Labels?.["saale.sandbox"];
      if (!identity) continue;
      rows.push({ identity, summary, container: docker.getContainer(summary.Id) });
    }
    return rows;
  }

  /**
   * Which workspace a preview hostname's slug names.
   *
   * The hash is one-way, so the answer comes from the containers that exist:
   * their labels carry the identity. One list serves every request for a few
   * seconds, because a page load is dozens of them.
   */
  async function identityForSlug(slug: string): Promise<string | null> {
    if (!slugIndex || now() - slugIndex.at > SLUG_INDEX_TTL_MS) {
      const bySlug = new Map<string, string>();
      try {
        for (const { identity } of await labelled()) {
          bySlug.set(previewIdentitySlug(identity), identity);
        }
      } catch (err) {
        console.error("Failed to list containers for a preview hostname:", err);
        return null;
      }
      slugIndex = { at: now(), bySlug };
    }
    return slugIndex.bySlug.get(slug) ?? null;
  }

  async function sweep(): Promise<{ stopped: number; removed: number }> {
    let stopped = 0;
    let removed = 0;
    for (const { identity, container, summary } of await labelled()) {
      // A container whose directory is gone mounts nothing this deployment can
      // name any more: it is a leftover of an identity that changed, and the
      // workspace it held now lives under the new name.
      const orphaned = await fs.stat(identityPath(identity)).then(
        () => false,
        (err: unknown) => isNotFoundError(err),
      );
      if (orphaned) {
        try {
          await container.remove({ force: true });
          lastUsed.delete(identity);
          slugIndex = null;
          removed += 1;
        } catch (err) {
          console.error(`Failed to remove orphaned sandbox container ${identity}:`, err);
        }
        continue;
      }

      if (summary.State === "exited" || summary.State === "created") continue;
      try {
        await container.stop({ t: 10 });
        lastUsed.delete(identity);
        stopped += 1;
      } catch (err) {
        console.error(`Failed to stop leftover sandbox container ${identity}:`, err);
      }
    }
    return { stopped, removed };
  }

  async function reapIdle(): Promise<{ stopped: number; removed: number }> {
    const idleMs = config.idleMinutes * 60_000;
    const ttlMs = config.ttlDays * 86_400_000;
    const at = now();
    let stopped = 0;
    let removed = 0;

    for (const { identity, container } of await labelled()) {
      let state: Dockerode.ContainerInspectInfo;
      try {
        state = await container.inspect();
      } catch (err) {
        if (isNotFound(err)) continue;
        console.error(`Failed to inspect sandbox container ${identity}:`, err);
        continue;
      }

      const created = Date.parse(state.Created);
      const age = Number.isFinite(created) ? at - created : 0;

      if (ttlMs > 0 && age > ttlMs) {
        try {
          await container.remove({ force: true });
          lastUsed.delete(identity);
          removed += 1;
        } catch (err) {
          console.error(`Failed to remove sandbox container ${identity}:`, err);
        }
        continue;
      }

      if (!state.State.Running) continue;
      // A command still running is the container being used, however long ago it
      // was started: a dev server is not idleness.
      if (registry.idsFor(identity).length > 0) continue;
      const used = lastUsed.get(identity) ?? created;
      if (Number.isFinite(used) && at - used > idleMs) {
        try {
          await container.stop({ t: 10 });
          lastUsed.delete(identity);
          stopped += 1;
        } catch (err) {
          console.error(`Failed to stop idle sandbox container ${identity}:`, err);
        }
      }
    }

    return { stopped, removed };
  }

  return { ensure, run, kill, write, resize, remove, stop, sweep, reapIdle, identityForSlug };
}

export function isAlreadyStarted(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { statusCode?: unknown }).statusCode === 304) return true;
  return (err as { code?: unknown }).code === 304;
}

export function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (statusCode === 404) return true;
  return (err as { code?: unknown }).code === 404;
}

/** The real Docker handle, cast to the structural slice this module uses. */
export function asDockerHandle(docker: Dockerode): DockerHandle {
  return docker as unknown as DockerHandle;
}
