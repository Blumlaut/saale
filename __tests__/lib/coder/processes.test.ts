import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopProcessesCommand } from "@/lib/coder/processes";

const run = promisify(execFile);

/**
 * The teardown sweep, run for real against real processes.
 *
 * `kill` is a shell builtin, so it cannot be stubbed; the pids in the fake
 * `/proc` are pids of `sleep` processes this test started. What the sweep must
 * get right is which of them it picks: a dev server whose command line never
 * names the worktree is still the worktree's, and one in the project's own
 * checkout is not.
 */

const children: ChildProcess[] = [];

/** The chat every sweep in this file is for. */
const CHAT_ID = "chat-1";

let root: string;
let procRoot: string;
let worktree: string;
let elsewhere: string;
let log: string;

function spawnSleep(): number {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(child);
  return child.pid as number;
}

async function observe(pid: number, cwd: string): Promise<void> {
  const dir = path.join(procRoot, String(pid));
  await fs.mkdir(dir, { recursive: true });
  await fs.symlink(cwd, path.join(dir, "cwd"));
}

/** The environment a process was started with, as the kernel keeps it. */
async function environ(pid: number, vars: Record<string, string>): Promise<void> {
  const dir = path.join(procRoot, String(pid));
  await fs.mkdir(dir, { recursive: true });
  const entries = Object.entries(vars).map(([name, value]) => `${name}=${value}`);
  await fs.writeFile(path.join(dir, "environ"), `${entries.join("\0")}\0`);
}

/**
 * The sweep's `kill` is delivered by the kernel as it runs, so by the time it
 * returns every kill has landed; this only lets libuv reap the children before
 * their exit state is read.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

/** The signal that took the process down, or null while it is still running. */
function exitSignal(pid: number): string | null {
  const child = children.find((candidate) => candidate.pid === pid);
  if (!child) return null;
  if (child.signalCode !== null) return child.signalCode;
  if (child.exitCode !== null) return "exited";
  return null;
}

async function runSweep(
  target: { ownCheckout?: string | null } = { ownCheckout: worktree },
): Promise<{ code: number }> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  // Only `pkill` is external; stubbing it records the command-line pass.
  const stub = path.join(bin, "pkill");
  await fs.writeFile(stub, `#!/bin/sh\necho "pkill $*" >> ${log}\nexit 0\n`, { mode: 0o755 });

  const command = stopProcessesCommand({ chatId: CHAT_ID, ...target }, procRoot);
  try {
    await run("bash", ["-c", command], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      timeout: 10_000,
    });
    return { code: 0 };
  } catch (err) {
    return { code: (err as { code?: number }).code ?? 1 };
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "saale-sweep-"));
  procRoot = path.join(root, "proc");
  worktree = path.join(root, "workspaces", "user-x", "worktrees", "saale", "c-1");
  elsewhere = path.join(root, "workspaces", "user-x", "projects", "saale");
  log = path.join(root, "pkill.log");

  await fs.mkdir(procRoot, { recursive: true });
  await fs.mkdir(path.join(worktree, "apps", "web"), { recursive: true });
  await fs.mkdir(elsewhere, { recursive: true });
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await fs.rm(root, { recursive: true, force: true });
});

describe("the worktree sweep", () => {
  it("kills what runs in the worktree and leaves the rest alone", async () => {
    const inRoot = spawnSleep();
    const inSubdirectory = spawnSleep();
    const inProject = spawnSleep();
    const inAnotherWorktree = spawnSleep();

    await observe(inRoot, worktree);
    await observe(inSubdirectory, path.join(worktree, "apps", "web"));
    await observe(inProject, elsewhere);
    await observe(inAnotherWorktree, path.join(root, "worktrees", "saale", "c-1"));

    await runSweep();
    await settle();

    expect(exitSignal(inRoot)).toBe("SIGKILL");
    expect(exitSignal(inSubdirectory)).toBe("SIGKILL");
    expect(exitSignal(inProject)).toBeNull();
    expect(exitSignal(inAnotherWorktree)).toBeNull();
  });

  it("still runs the command-line pass, for a process whose cwd it cannot read", async () => {
    const unreadable = spawnSleep();
    const dir = path.join(procRoot, String(unreadable));
    await fs.mkdir(dir, { recursive: true });
    await fs.symlink(path.join(root, "gone"), path.join(dir, "cwd"));

    const result = await runSweep();

    await settle();
    expect(result.code).toBe(0);
    expect(await fs.readFile(log, "utf8")).toContain(`pkill -f ${worktree}`);
    expect(exitSignal(unreadable)).toBeNull();
  });

  it("finishes cleanly with nothing to stop", async () => {
    const result = await runSweep();

    expect(result.code).toBe(0);
    expect(await fs.readFile(log, "utf8")).toContain(`pkill -f ${worktree}`);
  });
});

describe("the chat sweep", () => {
  it("kills what the chat started outside its checkout", async () => {
    const moved = spawnSleep();
    const otherChat = spawnSleep();
    const noEnvironment = spawnSleep();

    await environ(moved, { SAALE_CHAT_ID: CHAT_ID, HOME: "/w" });
    await environ(otherChat, { SAALE_CHAT_ID: "chat-2" });
    await observe(noEnvironment, elsewhere);

    // A checkout shared by several chats is swept by chat id alone.
    await runSweep({ ownCheckout: null });
    await settle();

    expect(exitSignal(moved)).toBe("SIGKILL");
    expect(exitSignal(otherChat)).toBeNull();
    expect(exitSignal(noEnvironment)).toBeNull();
  });

  it("reads the id as a whole entry, not as a prefix of another", async () => {
    const longerId = spawnSleep();
    const shorterId = spawnSleep();

    await environ(longerId, { SAALE_CHAT_ID: `${CHAT_ID}9` });
    await environ(shorterId, { SAALE_CHAT_ID: CHAT_ID });

    await runSweep({ ownCheckout: null });
    await settle();

    expect(exitSignal(longerId)).toBeNull();
    expect(exitSignal(shorterId)).toBe("SIGKILL");
  });
});
