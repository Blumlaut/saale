/**
 * Commands run on this host, for a checkout without a sandbox service.
 *
 * `sandbox-exec` is where commands run in production: one container per
 * identity, the workspaces volume mounted into it. A development instance has
 * no such service, and coder projects, the terminal and the file tools all need
 * to run something, so without it they would all be dead.
 *
 * This only answers when no service is configured and the build is not a
 * production one: a deployment that forgot `SANDBOX_URL` gets the old error
 * rather than commands running beside the database. What a command sees is
 * built here rather than inherited, so the app's own environment stays out.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { sandboxConfig } from "./config";
import { identityPath } from "./workspace";
import type { SandboxEvent, SandboxExecOptions } from "./client";

/** The image's `PATH`, with the workspace-local bin dir in front of it. */
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Local ids are distinguishable from the service's UUIDs. */
const LOCAL_ID_PREFIX = "local-";

/** Every command still running, so a stop or a keystroke can reach it. */
const running = new Map<string, ChildProcess>();

let nextId = 1;

/** Whether commands can run on this host: no service, and not a production build. */
export function localExecAllowed(): boolean {
  return !sandboxConfig().url && process.env.NODE_ENV !== "production";
}

export function isLocalExecId(execId: string): boolean {
  return execId.startsWith(LOCAL_ID_PREFIX);
}

/**
 * What a command runs with: the container's fixed variables and its own, never
 * the app's. `HOME` is the workspace root, which is where `.gitconfig` and
 * `~/.local/bin` live in the container.
 */
function commandEnv(
  identity: string,
  extra: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const root = identityPath(identity);
  return {
    HOME: root,
    PATH: `${root}/.local/bin:${SYSTEM_PATH}`,
    LANG: "C.UTF-8",
    NODE_ENV: process.env.NODE_ENV ?? "development",
    ...extra,
  };
}

/** Kill the command and everything it started, as the service does. */
function stopGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (child.pid === undefined) return;
  try {
    // Its own process group, so a shell's children go with it.
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Run one command here. Same events, same exit shape as the service. */
export async function* execLocally(options: SandboxExecOptions): AsyncGenerator<SandboxEvent> {
  const { identity, command, cwd, env, timeoutSeconds, interactive, signal } = options;
  if (!localExecAllowed()) throw new Error("SANDBOX_URL is not set");

  const execId = `${LOCAL_ID_PREFIX}${nextId++}`;
  const startedAt = Date.now();
  let timedOut = false;

  const child = spawn("/bin/sh", ["-c", command], {
    cwd: cwd ?? identityPath(identity),
    env: commandEnv(identity, env),
    // Its own group: a stopped dev server must not leave the compiler it
    // started behind.
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  running.set(execId, child);
  // Nothing to type into: the service attaches stdin only when asked.
  if (!interactive) child.stdin?.end();

  const queue: SandboxEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const push = (event: SandboxEvent) => {
    queue.push(event);
    wake?.();
    wake = null;
  };

  child.on("spawn", () => push({ type: "started", execId }));
  child.stdout?.on("data", (data: Buffer) => push({ type: "chunk", stream: "stdout", data }));
  child.stderr?.on("data", (data: Buffer) => push({ type: "chunk", stream: "stderr", data }));
  // A directory that is gone, or a shell that cannot start: the caller reads it
  // as the command's own failure.
  child.on("error", (err: Error) =>
    push({ type: "chunk", stream: "stderr", data: Buffer.from(`${err.message}\n`) }),
  );
  child.on("close", (code) => {
    finished = true;
    push({ type: "exit", exitCode: code ?? 1, timedOut, durationMs: Date.now() - startedAt });
  });

  const onAbort = () => stopGroup(child);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer =
    timeoutSeconds !== undefined
      ? setTimeout(() => {
          timedOut = true;
          stopGroup(child);
        }, timeoutSeconds * 1000)
      : null;

  try {
    for (;;) {
      const event = queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    running.delete(execId);
    // The consumer stopped reading before the command exited.
    if (!finished) stopGroup(child);
  }
}

/** Type into a command started with `interactive`. */
export function writeInputLocally(execId: string, data: Buffer | string): void {
  const child = running.get(execId);
  if (!child?.stdin || child.stdin.destroyed) return;
  child.stdin.write(typeof data === "string" ? Buffer.from(data, "utf8") : data);
}

/** Stop a command started here. A command that already exited is ignored. */
export function killLocally(execId: string): void {
  const child = running.get(execId);
  if (!child) return;
  stopGroup(child, "SIGTERM");
}
