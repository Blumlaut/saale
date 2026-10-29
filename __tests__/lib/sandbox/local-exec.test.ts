import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Commands on the dev host.
 *
 * A checkout without `sandbox-exec` still runs coder projects, the terminal and
 * the file tools here, so the fallback has to answer with the same events: what
 * a command printed on each stream, its exit code, a timeout that kills it, and
 * a stop that reaches what the shell started.
 */

import {
  execLocally,
  isLocalExecId,
  killLocally,
  localExecAllowed,
  writeInputLocally,
} from "@/lib/sandbox/local";

const IDENTITY = "user-testdev";
const ENV_LEAK = "SAALE_LOCAL_EXEC_LEAK";
const ENV_LEAK_OPENER = "SAALE_LOCAL_EXEC_OPENER";

let volume = "";
let originalWorkspacesDir: string | undefined;
let originalSandboxUrl: string | undefined;

/** Everything a command printed, and how it ended. */
async function run(
  command: string,
  options: {
    cwd?: string;
    timeoutSeconds?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
    tty?: boolean;
    cols?: number;
    rows?: number;
  } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;
  let timedOut = false;
  let execId = "";

  for await (const event of execLocally({
    identity: IDENTITY,
    command,
    ...options,
  })) {
    if (event.type === "started") execId = event.execId;
    else if (event.type === "chunk") {
      (event.stream === "stdout" ? stdout : stderr).push(event.data.toString("utf8"));
    } else {
      exitCode = event.exitCode;
      timedOut = event.timedOut;
    }
  }

  return { execId, stdout: stdout.join(""), stderr: stderr.join(""), exitCode, timedOut };
}

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "saale-local-exec-"));
  await mkdir(path.join(volume, IDENTITY, ".local", "bin"), { recursive: true });
  originalWorkspacesDir = process.env.SANDBOX_WORKSPACES_DIR;
  originalSandboxUrl = process.env.SANDBOX_URL;
  process.env.SANDBOX_WORKSPACES_DIR = volume;
  delete process.env.SANDBOX_URL;
});

afterAll(async () => {
  if (originalWorkspacesDir === undefined) delete process.env.SANDBOX_WORKSPACES_DIR;
  else process.env.SANDBOX_WORKSPACES_DIR = originalWorkspacesDir;
  if (originalSandboxUrl !== undefined) process.env.SANDBOX_URL = originalSandboxUrl;
  await rm(volume, { recursive: true, force: true });
});

beforeEach(() => {
  // An app variable that must not reach a command.
  process.env[ENV_LEAK] = "leaked";
});

afterEach(() => {
  delete process.env[ENV_LEAK];
  delete process.env[ENV_LEAK_OPENER];
});

describe("localExecAllowed", () => {
  it("answers when there is no service", () => {
    expect(localExecAllowed()).toBe(true);
  });

  it("stands down when a sandbox service is configured", () => {
    process.env.SANDBOX_URL = "http://sandbox-exec:8100";
    try {
      expect(localExecAllowed()).toBe(false);
    } finally {
      delete process.env.SANDBOX_URL;
    }
  });
});

describe("execLocally", () => {
  it("streams both outputs and the exit code, under a local id", async () => {
    const result = await run("echo out; echo err >&2; exit 3");

    expect(result.execId).toMatch(/^local-\d+$/);
    expect(isLocalExecId(result.execId)).toBe(true);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it("runs in the directory it was given", async () => {
    await mkdir(path.join(volume, IDENTITY, "projects", "one"), { recursive: true });

    const result = await run("pwd", { cwd: path.join(volume, IDENTITY, "projects", "one") });

    expect(result.stdout.trim()).toBe(path.join(volume, IDENTITY, "projects", "one"));
  });

  it("gives the command the workspace as HOME, and no app variables", async () => {
    const result = await run(`echo "$HOME"; printenv ${ENV_LEAK} || echo no-leak`);

    expect(result.stdout.split("\n")).toEqual([path.join(volume, IDENTITY), "no-leak", ""]);
  });

  it("passes the variables a caller asked for", async () => {
    const result = await run(`echo "$${ENV_LEAK_OPENER}"`, {
      env: { [ENV_LEAK_OPENER]: "yes" },
    });

    expect(result.stdout.trim()).toBe("yes");
  });

  it("puts the workspace's own bin dir in front of PATH", async () => {
    const dir = path.join(volume, IDENTITY, ".local", "bin");
    const script = path.join(dir, "workspace-tool");
    await writeFile(script, "#!/bin/sh\necho from-the-workspace\n");
    await chmod(script, 0o755);

    const result = await run("workspace-tool");

    expect(result.stdout.trim()).toBe("from-the-workspace");
  });

  it("kills a command that runs past its timeout", async () => {
    const result = await run("sleep 5", { timeoutSeconds: 1 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("kills a command when its caller aborts", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);

    const result = await run("sleep 5", { signal: abort.signal });

    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("answers a stop, taking what the shell started with it", async () => {
    await mkdir(path.join(volume, IDENTITY, "run"), { recursive: true });
    const marker = path.join(volume, IDENTITY, "run", "child");
    const command = `(sleep 5; touch ${marker}) & sleep 5`;

    const events = execLocally({ identity: IDENTITY, command });
    const started = await events.next();
    expect(started.value).toEqual({
      type: "started",
      execId: expect.stringMatching(/^local-\d+$/),
    });
    const execId = (started.value as { execId: string }).execId;

    killLocally(execId);
    for (;;) {
      const next = await events.next();
      if (next.done) break;
    }

    // The background sleep went with the group, so it never reaches the marker.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("types into an interactive command", async () => {
    const events = execLocally({ identity: IDENTITY, command: "cat", interactive: true });
    const started = await events.next();
    const execId = (started.value as { execId: string }).execId;

    writeInputLocally(execId, "hello\n");
    const chunk = await events.next();
    expect((chunk.value as { data: Buffer }).data.toString("utf8")).toBe("hello\n");
  });

  it("runs a terminal command on a pty of the size it was given", async () => {
    const result = await run("stty size; tty", {
      tty: true,
      cols: 100,
      rows: 30,
      env: { TERM: "xterm-256color" },
    });

    expect(result.stdout).toContain("30 100");
    expect(result.stdout).toContain("/dev/pts/");
    expect(result.exitCode).toBe(0);
  });

  it("reports a directory that is not there as the command's failure", async () => {
    const result = await run("true", { cwd: path.join(volume, IDENTITY, "gone") });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
  });
});
