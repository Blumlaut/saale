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

/** Whether the process is gone, and by which signal. */
function died(pid: number, timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = children.find((candidate) => candidate.pid === pid);
    if (!child) return resolve(null);
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.signalCode);

    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (_code, signal) => {
      clearTimeout(timer);
      resolve(signal);
    });
  });
}

async function runSweep(): Promise<{ code: number }> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  // Only `pkill` is external; stubbing it records the command-line pass.
  const stub = path.join(bin, "pkill");
  await fs.writeFile(stub, `#!/bin/sh\necho "pkill $*" >> ${log}\nexit 0\n`, { mode: 0o755 });

  try {
    await run("bash", ["-c", stopProcessesCommand(worktree, procRoot)], {
      cwd: worktree,
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

    expect(await died(inRoot)).toBe("SIGKILL");
    expect(await died(inSubdirectory)).toBe("SIGKILL");
    expect(await died(inProject)).toBeNull();
    expect(await died(inAnotherWorktree)).toBeNull();
  });

  it("still runs the command-line pass, for a process whose cwd it cannot read", async () => {
    const unreadable = spawnSleep();
    const dir = path.join(procRoot, String(unreadable));
    await fs.mkdir(dir, { recursive: true });
    await fs.symlink(path.join(root, "gone"), path.join(dir, "cwd"));

    const result = await runSweep();

    expect(result.code).toBe(0);
    expect(await fs.readFile(log, "utf8")).toContain(`pkill -f ${worktree}`);
    expect(await died(unreadable)).toBeNull();
  });

  it("finishes cleanly with nothing to stop", async () => {
    const result = await runSweep();

    expect(result.code).toBe(0);
    expect(await fs.readFile(log, "utf8")).toContain(`pkill -f ${worktree}`);
  });
});
