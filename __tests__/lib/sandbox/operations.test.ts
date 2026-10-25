import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@/lib/sandbox/client";

const hoisted = vi.hoisted(() => ({ exec: vi.fn(), kill: vi.fn() }));

vi.mock("@/lib/sandbox/client", () => ({
  exec: hoisted.exec,
  kill: hoisted.kill,
}));

import { createSandboxOperations, type SandboxEnv } from "@/lib/sandbox/operations";
import { FileNotFoundError, isNotFoundError } from "@/lib/files/errors";

let root: string;
let tempRoot: string;

/** A scripted command: yields these events, then ends. */
function script(events: SandboxEvent[]) {
  hoisted.exec.mockImplementation(async function* () {
    for (const event of events) yield event;
  });
}

function operations(env?: SandboxEnv) {
  return createSandboxOperations({ identity: "user-abc", root, env });
}

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-ops-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", tempRoot);
  vi.stubEnv("SANDBOX_USER", "root");
  root = path.join(tempRoot, "user-abc");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
});

describe("bash", () => {
  async function run(
    command: string,
    context: { onData?: (data: Buffer) => void; signal?: AbortSignal; timeout?: number } = {},
    requestedCwd?: string,
  ) {
    const ops = operations({ GH_TOKEN: "s3cret" });
    const onData = context.onData ?? (() => {});
    return ops.bash.exec(command, requestedCwd ?? root, {
      onData,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.timeout ? { timeout: context.timeout } : {}),
    } as never);
  }

  it("streams both lanes to onData and returns the exit code", async () => {
    script([
      { type: "started", execId: "exec-1" },
      { type: "chunk", stream: "stdout", data: Buffer.from("out\n") },
      { type: "chunk", stream: "stderr", data: Buffer.from("err\n") },
      { type: "exit", exitCode: 2, timedOut: false, durationMs: 5 },
    ]);

    const received: string[] = [];
    const result = await run("ls", { onData: (data) => received.push(data.toString()) });

    expect(result).toEqual({ exitCode: 2 });
    expect(received).toEqual(["out\n", "err\n"]);
    expect(hoisted.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: "user-abc",
        command: "ls",
        cwd: root,
        env: expect.objectContaining({ GH_TOKEN: "s3cret" }),
      }),
    );
  });

  it("sends only the app's git defaults into a session with no variables", async () => {
    script([{ type: "exit", exitCode: 0, timedOut: false, durationMs: 1 }]);

    await operations().bash.exec("env", root, { onData: () => {} } as never);

    const options = hoisted.exec.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      LC_ALL: "C",
    });
  });

  it("asks a getter per command, so a value can change between them", async () => {
    script([{ type: "exit", exitCode: 0, timedOut: false, durationMs: 1 }]);
    const env = vi.fn().mockResolvedValueOnce({ SAALE_MODEL: "first" }).mockResolvedValueOnce({
      SAALE_MODEL: "second",
    });
    const ops = operations(env);

    await ops.bash.exec("true", root, { onData: () => {} } as never);
    await ops.bash.exec("true", root, { onData: () => {} } as never);

    expect(env).toHaveBeenCalledTimes(2);
    expect(hoisted.exec.mock.calls[0]![0].env).toMatchObject({ SAALE_MODEL: "first" });
    expect(hoisted.exec.mock.calls[1]![0].env).toMatchObject({ SAALE_MODEL: "second" });
  });

  it("clamps a cwd outside the workspace back to its root", async () => {
    script([{ type: "exit", exitCode: 0, timedOut: false, durationMs: 1 }]);

    await run("pwd", {}, "/etc");

    expect(hoisted.exec).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }));
  });

  it("keeps a cwd inside the workspace", async () => {
    script([{ type: "exit", exitCode: 0, timedOut: false, durationMs: 1 }]);
    const inner = path.join(root, "src");

    await run("pwd", {}, inner);

    expect(hoisted.exec).toHaveBeenCalledWith(expect.objectContaining({ cwd: inner }));
  });

  it("forwards the timeout and reports it the way Pi renders it", async () => {
    script([
      { type: "started", execId: "exec-1" },
      { type: "exit", exitCode: 143, timedOut: true, durationMs: 30_000 },
    ]);

    await expect(run("sleep 100", { timeout: 30 })).rejects.toThrow("timeout:30");
    expect(hoisted.exec).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 30 }));
  });

  it("reports a stop as an abort, not as an exit code the model would read", async () => {
    const controller = new AbortController();
    hoisted.exec.mockImplementation(async function* () {
      yield { type: "started", execId: "exec-1" } as SandboxEvent;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    await expect(run("sleep 100", { signal: controller.signal })).rejects.toThrow("aborted");
  });

  it("surfaces a service failure instead of an empty success", async () => {
    hoisted.exec.mockImplementation(async function* () {
      throw new Error("sandbox-exec 500: container is down");

      yield { type: "exit", exitCode: 0, timedOut: false, durationMs: 0 } as SandboxEvent;
    });

    await expect(run("ls")).rejects.toThrow(/container is down/);
  });
});

describe("file operations", () => {
  it("reads a file inside the workspace", async () => {
    await fs.writeFile(path.join(root, "notes.md"), "# hello");

    const bytes = await operations().read.readFile(path.join(root, "notes.md"));

    expect(bytes.toString()).toBe("# hello");
  });

  it("creates parents on write, so a new tree needs no mkdir first", async () => {
    await operations().write.writeFile(path.join(root, "a", "b", "c.txt"), "x");

    expect(await fs.readFile(path.join(root, "a", "b", "c.txt"), "utf8")).toBe("x");
  });

  it("creates a directory", async () => {
    await operations().write.mkdir(path.join(root, "new", "dir"));

    expect((await fs.stat(path.join(root, "new", "dir"))).isDirectory()).toBe(true);
  });

  it("points the model at the scratch directory when a path escapes", async () => {
    const ops = operations();

    await expect(ops.read.readFile("/tmp/pw.png")).rejects.toThrow(
      /outside the workspace.*\.tmp\/.*emptied automatically/,
    );
    await expect(ops.write.writeFile("/tmp/pw.png", "x")).rejects.toThrow(/outside the workspace/);
  });

  it("refuses a path outside the workspace, whatever the model wrote", async () => {
    const ops = operations();

    await expect(ops.read.readFile("/etc/passwd")).rejects.toThrow(/outside the workspace/);
    await expect(ops.write.writeFile("../user-other/x.txt", "x")).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(ops.edit.access("/root/.ssh/id_rsa")).rejects.toThrow(/outside the workspace/);
  });

  it("refuses a symlink that points into another identity's directory", async () => {
    const other = path.join(tempRoot, "user-other");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "secret.txt"), "top secret");
    await fs.symlink(path.join(other, "secret.txt"), path.join(root, "link.txt"));

    await expect(operations().read.readFile(path.join(root, "link.txt"))).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it("reports a missing file as ENOENT, which is what Pi's access check expects", async () => {
    await expect(operations().read.access(path.join(root, "gone.txt"))).rejects.toThrow(
      /ENOENT: no such file or directory/,
    );
  });

  it("sniffs an image so the model gets pixels rather than bytes", async () => {
    const ops = operations();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.writeFile(path.join(root, "shot.png"), png);

    await expect(ops.read.detectImageMimeType!(path.join(root, "shot.png"))).resolves.toBe(
      "image/png",
    );
  });

  it("reports a non-image as null, and a missing file as null too", async () => {
    const ops = operations();
    await fs.writeFile(path.join(root, "notes.md"), "# hi");

    await expect(ops.read.detectImageMimeType!(path.join(root, "notes.md"))).resolves.toBeNull();
    await expect(ops.read.detectImageMimeType!(path.join(root, "gone.png"))).resolves.toBeNull();
  });

  it("surfaces the filesystem's own ENOENT for a read of a path that is not there", async () => {
    const error = await operations()
      .read.readFile(path.join(root, "gone.txt"))
      .catch((err: unknown) => err);

    expect(isNotFoundError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(FileNotFoundError);
  });
});
