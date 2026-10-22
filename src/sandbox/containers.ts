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
import { PassThrough } from "node:stream";
import type Dockerode from "dockerode";
import type { SandboxConfig } from "@/lib/sandbox/config";
import { parseIdentity } from "@/lib/sandbox/identity";
import { containerName, containerSpec, containerWorkspacePath } from "@/lib/sandbox/spec";
import { ensureWorkspace } from "@/lib/sandbox/workspace";
import { checkMountinfo } from "./mount-check";
import {
  createExecRegistry,
  UnknownExecError,
  type ExecRegistry,
  type RunningExec,
} from "./registry";

/** The slice of a container this module uses. */
export interface ContainerHandle {
  id?: string;
  start(): Promise<unknown>;
  stop(options?: { t?: number }): Promise<unknown>;
  remove(options?: { force?: boolean }): Promise<unknown>;
  inspect(): Promise<Dockerode.ContainerInspectInfo>;
  exec(options: Dockerode.ExecCreateOptions): Promise<ExecHandle>;
}

/** The slice of an exec this module uses. */
export interface ExecHandle {
  id: string;
  start(options?: Dockerode.ExecStartOptions): Promise<NodeJS.ReadableStream>;
  inspect(options?: Dockerode.ExecInspectOptions): Promise<Dockerode.ExecInspectInfo>;
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
/** How long to wait for Docker to report an exit code after the stream ends. */
const EXIT_POLL_MS = 100;
const EXIT_POLL_TRIES = 50;

export interface ContainerManager {
  ensure(identity: string): Promise<ContainerHandle>;
  run(
    identity: string,
    request: SandboxExecRequest,
    onChunk: (chunk: SandboxChunk) => void,
  ): Promise<SandboxExecSession>;
  kill(id: string): Promise<void>;
  /** Remove an identity's container. Its directory stays. */
  remove(identity: string): Promise<boolean>;
  stop(identity: string): Promise<boolean>;
  /** Stop anything a previous process left behind. */
  sweep(): Promise<number>;
  /** Stop idle containers, remove ones past their time to live. */
  reapIdle(): Promise<{ stopped: number; removed: number }>;
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

  /** Signal a command's process group. `setsid` made it a group of its own. */
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
      await container.start();
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

  async function ensure(identity: string): Promise<ContainerHandle> {
    const id = parseIdentity(identity);
    const name = containerName(id);
    const existing = await inspectOrNull(name);

    if (existing) {
      const container = docker.getContainer(name);
      if (!existing.State.Running) await container.start();
      lastUsed.set(id, now());
      return container;
    }

    const container = await create(id);
    lastUsed.set(id, now());
    return container;
  }

  async function run(
    identity: string,
    request: SandboxExecRequest,
    onChunk: (chunk: SandboxChunk) => void,
  ): Promise<SandboxExecSession> {
    const id = parseIdentity(identity);
    if (!request.command.trim()) throw new SandboxRequestError("A command is required");

    const container = await ensure(id);
    const execId = randomUUID();
    const pgidFile = `/tmp/.saale-${execId}.pgid`;
    const cwd = confineCwd(id, request.cwd, config);

    const exec = await container.exec({
      Cmd: [
        // `--wait` because setsid forks when the exec's process is already a
        // group leader: without it the exec reports setsid's own 0 and the
        // command's status is lost.
        "setsid",
        "--wait",
        "sh",
        "-c",
        // $$ is the session leader setsid just created, which is the group id
        // the stop path signals; exec keeps that pid.
        `echo $$ > ${pgidFile}; exec bash -c "$1"`,
        "sh",
        request.command,
      ],
      User: config.user,
      WorkingDir: cwd,
      Env: envList(request.env),
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stream = await exec.start({ hijack: true, stdin: true });
    const entry: RunningExec = { identity: id, pgidFile, container, exec, settled: false };
    registry.add(execId, entry);
    lastUsed.set(id, now());

    const startedAt = now();
    let timedOut = false;

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("data", (data: Buffer) => onChunk({ stream: "stdout", data }));
    stderr.on("data", (data: Buffer) => onChunk({ stream: "stderr", data }));
    docker.modem.demuxStream(stream, stdout, stderr);

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

  async function sweep(): Promise<number> {
    let stopped = 0;
    for (const { identity, container, summary } of await labelled()) {
      if (summary.State === "exited" || summary.State === "created") continue;
      try {
        await container.stop({ t: 10 });
        lastUsed.delete(identity);
        stopped += 1;
      } catch (err) {
        console.error(`Failed to stop leftover sandbox container ${identity}:`, err);
      }
    }
    return stopped;
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

  return { ensure, run, kill, remove, stop, sweep, reapIdle };
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
