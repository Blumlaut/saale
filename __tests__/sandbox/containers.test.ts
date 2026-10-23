import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type Dockerode from "dockerode";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { previewIdentitySlug } from "@/lib/preview/url";
import { sandboxConfig } from "@/lib/sandbox/config";
import type { containerSpec } from "@/lib/sandbox/spec";
import {
  confineCwd,
  createContainerManager,
  envList,
  SandboxRequestError,
  type ContainerHandle,
  type DockerHandle,
  type ExecHandle,
  type SandboxChunk,
} from "@/sandbox/containers";

/** A docker stream frame: type byte, three padding bytes, big-endian length. */
function frame(type: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

class FakeExec implements ExecHandle {
  readonly id = `exec-${Math.random().toString(16).slice(2)}`;
  readonly stream = new PassThrough();
  /** Bytes a caller typed into the command, in order. */
  readonly written: Buffer[] = [];
  finished = false;
  exitCode: number | null = null;
  started = false;

  constructor(readonly options: unknown) {}

  async start(options: { stdin?: boolean } = {}): Promise<NodeJS.ReadableStream> {
    this.started = true;
    this.stdin = options.stdin === true;
    if (this.stdin) {
      this.stream.write = ((chunk: Buffer, callback?: (error?: Error | null) => void) => {
        this.written.push(Buffer.from(chunk));
        callback?.(null);
        return true;
      }) as typeof this.stream.write;
    }
    return this.stream;
  }

  /** Whether the manager asked the daemon to attach stdin. */
  stdin = false;

  async inspect(): Promise<Dockerode.ExecInspectInfo> {
    return { Running: !this.finished, ExitCode: this.exitCode } as Dockerode.ExecInspectInfo;
  }

  /** Feed one docker-framed chunk. */
  emit(type: 1 | 2, text: string): void {
    this.stream.write(frame(type, text));
  }

  finish(exitCode: number): void {
    this.finished = true;
    this.exitCode = exitCode;
    this.stream.end();
  }
}

class FakeContainer implements ContainerHandle {
  readonly execs: FakeExec[] = [];
  running = false;
  removed = false;
  startedCount = 0;
  /** The next `start` rejects with this, the way the daemon reports a race. */
  startError: (Error & { statusCode?: number }) | null = null;
  readonly created = Date.parse("2026-01-01T00:00:00Z");

  constructor(
    readonly name: string,
    readonly createOptions: Record<string, unknown> | null,
    /** Mountinfo the container reports for `cat /proc/self/mountinfo`. */
    private readonly mountinfo: string,
  ) {}

  async start(): Promise<void> {
    if (this.startError) {
      const error = this.startError;
      this.startError = null;
      throw error;
    }
    this.running = true;
    this.startedCount += 1;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async remove(): Promise<void> {
    this.removed = true;
    this.running = false;
  }

  async inspect(): Promise<never> {
    return {
      Id: this.name,
      Name: `/${this.name}`,
      State: { Running: this.running, Status: this.running ? "running" : "exited" },
      Created: new Date(this.created).toISOString(),
    } as never;
  }

  async exec(options: { Cmd?: string[] }): Promise<ExecHandle> {
    const exec = new FakeExec(options);
    this.execs.push(exec);

    if (options.Cmd?.[0] === "cat") {
      // The mount check reads the kernel's view and exits.
      queueMicrotask(() => {
        exec.emit(1, this.mountinfo);
        exec.finish(0);
      });
    } else if (options.Cmd?.[0] === "sh") {
      // The stop script signals the group and exits straight away.
      queueMicrotask(() => exec.finish(0));
    }
    return exec;
  }

  /** The exec a test should talk to: the `setsid` wrapper around the command. */
  commandExec(): FakeExec {
    const commands = this.execs.filter(
      (exec) => (exec.options as { Cmd?: string[] }).Cmd?.[0] === "setsid",
    );
    const last = commands[commands.length - 1];
    if (!last) throw new Error("no command exec");
    return last;
  }

  killExecs(): FakeExec[] {
    return this.execs.filter((exec) => {
      const cmd = (exec.options as { Cmd?: string[] }).Cmd;
      return cmd?.join(" ").includes("kill -");
    });
  }
}

class FakeDocker implements DockerHandle {
  readonly containers = new Map<string, FakeContainer>();
  readonly createdOptions: Record<string, unknown>[] = [];
  modem = {
    demuxStream: (
      stream: NodeJS.ReadableStream,
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
    ) => {
      let buffer = Buffer.alloc(0);
      stream.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
          const type = buffer[0];
          const length = buffer.readUInt32BE(4);
          if (buffer.length < 8 + length) break;
          const payload = buffer.subarray(8, 8 + length);
          (type === 2 ? stderr : stdout).write(payload);
          buffer = buffer.subarray(8 + length);
        }
      });
      stream.on("end", () => {
        stdout.end();
        stderr.end();
      });
    },
  };

  constructor(private readonly workspacesDir: string) {}

  getContainer(name: string): ContainerHandle {
    const container = this.containers.get(name);
    if (!container) {
      const error = new Error(`No such container: ${name}`) as Error & { statusCode: number };
      error.statusCode = 404;
      throw error;
    }
    return container;
  }

  async createContainer(options: Record<string, unknown>): Promise<ContainerHandle> {
    this.createdOptions.push(options);
    const name = String(options.name);
    const target = String(
      (options.HostConfig as { Mounts: Array<{ Target: string }> }).Mounts[0]!.Target,
    );
    const container = new FakeContainer(
      name,
      options,
      [
        `999 100 0:99 / / rw - ext4 overlay rw`,
        `1000 999 0:50 ${target} ${target} rw - ext4 vol rw`,
      ].join("\n"),
    );
    this.containers.set(name, container);
    return container;
  }

  async listContainers(): Promise<
    Array<{ Id: string; Labels: Record<string, string>; State: string }>
  > {
    return [...this.containers.values()].map((container) => ({
      Id: container.name,
      Labels: {
        "saale.sandbox": String(
          (container.createOptions?.Labels as Record<string, string>)["saale.sandbox"],
        ),
      },
      State: container.running ? "running" : "exited",
    }));
  }

  /** Containers the manager created, by identity. */
  byIdentity(identity: string): FakeContainer {
    const container = this.containers.get(`saale-sandbox-${identity}`);
    if (!container) throw new Error(`no container for ${identity}`);
    return container;
  }

  get workspaces(): string {
    return this.workspacesDir;
  }
}

let workspaces: string;
let docker: FakeDocker;
let config = sandboxConfig();

function manager(now?: () => number) {
  return createContainerManager({ docker, config, ...(now ? { now } : {}) });
}

beforeAll(async () => {
  workspaces = await fs.mkdtemp(path.join(os.tmpdir(), "saale-containers-"));
});

afterAll(async () => {
  await fs.rm(workspaces, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", workspaces);
  vi.stubEnv("SANDBOX_USER", "root");
  vi.stubEnv("SANDBOX_IDLE_MINUTES", "60");
  vi.stubEnv("SANDBOX_CONTAINER_TTL_DAYS", "7");
  for (const entry of await fs.readdir(workspaces)) {
    await fs.rm(path.join(workspaces, entry), { recursive: true, force: true });
  }
  config = sandboxConfig();
  docker = new FakeDocker(workspaces);
});

describe("ensure", () => {
  it("creates the directory, the container and starts it", async () => {
    const container = (await manager().ensure("user-abc")) as FakeContainer;

    expect((await fs.stat(path.join(workspaces, "user-abc"))).isDirectory()).toBe(true);
    expect(docker.createdOptions).toHaveLength(1);
    expect(docker.createdOptions[0]!.name).toBe("saale-sandbox-user-abc");
    expect(container.running).toBe(true);
  });

  it("brings up one container when commands arrive together", async () => {
    const containers = manager();

    const [first, second] = await Promise.all([
      containers.ensure("user-abc"),
      containers.ensure("user-abc"),
    ]);

    expect(docker.createdOptions).toHaveLength(1);
    expect(second).toBe(first);
    expect(docker.byIdentity("user-abc").startedCount).toBe(1);
  });

  it("starts a stopped container once for commands issued together", async () => {
    const containers = manager();
    await containers.ensure("user-abc");
    await docker.byIdentity("user-abc").stop();

    await Promise.all([containers.ensure("user-abc"), containers.ensure("user-abc")]);

    expect(docker.byIdentity("user-abc").startedCount).toBe(2);
  });

  it("accepts a start the daemon answers with 304", async () => {
    const container = (await manager().ensure("user-abc")) as FakeContainer;
    await container.stop();
    container.running = true;
    container.startError = Object.assign(new Error("(HTTP code 304) container already started"), {
      statusCode: 304,
    });

    await expect(manager().ensure("user-abc")).resolves.toBe(container);
  });

  it("reports a start that fails for another reason", async () => {
    const container = (await manager().ensure("user-abc")) as FakeContainer;
    await container.stop();
    container.startError = Object.assign(new Error("(HTTP code 500) cannot start"), {
      statusCode: 500,
    });

    await expect(manager().ensure("user-abc")).rejects.toThrow("cannot start");
  });

  it("reuses a running container instead of creating a second one", async () => {
    const first = await manager().ensure("user-abc");
    const second = await manager().ensure("user-abc");

    expect(docker.createdOptions).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("starts a container that was stopped, and keeps it", async () => {
    const created = (await manager().ensure("user-abc")) as FakeContainer;
    await created.stop();

    const started = (await manager().ensure("user-abc")) as FakeContainer;

    expect(started).toBe(created);
    expect(started.running).toBe(true);
    expect(docker.createdOptions).toHaveLength(1);
    expect(started.startedCount).toBe(2);
  });

  it("destroys a container whose mount view is wrong", async () => {
    // A container that mounted the workspaces root instead of the subpath.
    const broken = new FakeDocker(workspaces);
    broken.createContainer = async (options) => {
      const container = new FakeContainer(
        String(options.name),
        options as Record<string, unknown>,
        "1000 999 0:50 /workspaces /workspaces rw - ext4 vol rw",
      );
      broken.containers.set(container.name, container);
      return container;
    };

    const brokenManager = createContainerManager({ docker: broken, config });

    await expect(brokenManager.ensure("user-abc")).rejects.toThrow(/Refusing container/);
    expect(broken.byIdentity("user-abc").removed).toBe(true);
  });
});

describe("run", () => {
  it("streams stdout and stderr as separate lanes, then reports the exit code", async () => {
    const chunks: SandboxChunk[] = [];
    const session = await manager().run("user-abc", { command: "ls" }, (chunk) =>
      chunks.push(chunk),
    );

    const exec = docker.byIdentity("user-abc").commandExec();
    exec.emit(1, "file-a\n");
    exec.emit(2, "warning\n");
    exec.finish(0);

    await expect(session.result).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    expect(chunks).toEqual([
      { stream: "stdout", data: Buffer.from("file-a\n") },
      { stream: "stderr", data: Buffer.from("warning\n") },
    ]);
  });

  it("runs the command under setsid so a stop can signal the whole group", async () => {
    await manager().run("user-abc", { command: "sleep 100 | cat" }, () => {});

    const cmd = (docker.byIdentity("user-abc").commandExec().options as { Cmd: string[] }).Cmd;
    expect(cmd[0]).toBe("setsid");
    // `--wait` is what makes the exec report the command's status, not setsid's.
    expect(cmd[1]).toBe("--wait");
    expect(cmd[2]).toBe("sh");
    // `$$` is the session leader setsid created, which is the group id.
    expect(cmd[4]).toContain("echo $$ >");
    expect(cmd[4]).toContain(`/tmp/.saale-`);
    expect(cmd[4]).toContain('exec bash -c "$1"');
    // The user's command is an argument, never interpolated into the script.
    expect(cmd[6]).toBe("sleep 100 | cat");
  });

  it("runs as the configured user and in the identity's directory", async () => {
    const home = path.join(workspaces, "user-abc");
    await manager().run("user-abc", { command: "pwd", cwd: `${home}/sub` }, () => {});

    const options = docker.byIdentity("user-abc").commandExec().options as {
      User: string;
      WorkingDir: string;
      Env: string[];
    };
    expect(options.User).toBe("root");
    expect(options.WorkingDir).toBe(`${home}/sub`);
    expect(options.Env).toEqual([]);
  });

  it("passes the request's variables to that one exec only", async () => {
    await manager().run("user-abc", { command: "env", env: { GH_TOKEN: "s3cret" } }, () => {});

    const container = docker.byIdentity("user-abc");
    expect((container.commandExec().options as { Env: string[] }).Env).toEqual(["GH_TOKEN=s3cret"]);
    // The container's own environment is untouched.
    const spec = container.createOptions as unknown as ReturnType<typeof containerSpec>;
    expect(spec.Env.some((entry) => entry.includes("s3cret"))).toBe(false);
  });

  it("refuses a working directory outside the identity's directory", async () => {
    await expect(
      manager().run(
        "user-abc",
        { command: "pwd", cwd: path.join(workspaces, "user-other") },
        () => {},
      ),
    ).rejects.toThrow(SandboxRequestError);
  });

  it("stops a command that runs past its timeout and says it timed out", async () => {
    const session = await manager().run(
      "user-abc",
      { command: "sleep 100", timeoutSeconds: 0.05 },
      () => {},
    );

    const container = docker.byIdentity("user-abc");
    // `kill` shells out to the process group and then the command ends.
    await vi.waitFor(() => expect(container.killExecs().length).toBeGreaterThan(0));
    container.commandExec().finish(143);

    await expect(session.result).resolves.toMatchObject({ exitCode: 143, timedOut: true });
    const killScript = (container.killExecs()[0]!.options as { Cmd: string[] }).Cmd[2]!;
    expect(killScript).toContain("kill -TERM -$p");
  });
});

describe("kill", () => {
  it("signals the command's process group", async () => {
    const managerInstance = manager();
    const session = await managerInstance.run("user-abc", { command: "sleep 100" }, () => {});

    await managerInstance.kill(session.id);

    const kill = (docker.byIdentity("user-abc").killExecs()[0]!.options as { Cmd: string[] }).Cmd;
    expect(kill[2]).toContain(`cat /tmp/.saale-${session.id}.pgid`);

    docker.byIdentity("user-abc").commandExec().finish(143);
    await expect(session.result).resolves.toMatchObject({ exitCode: 143 });
  });

  it("refuses an id it does not know", async () => {
    await expect(manager().kill("nope")).rejects.toThrow(/No running command/);
  });

  it("leaves a command that already finished alone", async () => {
    const managerInstance = manager();
    const session = await managerInstance.run("user-abc", { command: "true" }, () => {});
    docker.byIdentity("user-abc").commandExec().finish(0);
    await session.result;

    await expect(managerInstance.kill(session.id)).rejects.toThrow(/No running command/);
  });
});

describe("write", () => {
  it("attaches stdin only when the command asked for it", async () => {
    const managerInstance = manager();
    const plain = await managerInstance.run("user-abc", { command: "ls" }, () => {});
    const interactive = await managerInstance.run(
      "user-abc",
      { command: "npm init", interactive: true },
      () => {},
    );

    const execs = docker
      .byIdentity("user-abc")
      .execs.filter((exec) => (exec.options as { Cmd?: string[] }).Cmd?.[0] === "setsid");
    expect((execs[0]!.options as { AttachStdin?: boolean }).AttachStdin).toBeFalsy();
    expect((execs[1]!.options as { AttachStdin?: boolean }).AttachStdin).toBe(true);
    // The socket is only busy for a command that can read it.
    expect(execs[0]!.stdin).toBe(false);
    expect(execs[1]!.stdin).toBe(true);

    await expect(managerInstance.write(plain.id, "user-abc", Buffer.from("a"))).rejects.toThrow(
      /not started with stdin/,
    );
    await managerInstance.write(interactive.id, "user-abc", Buffer.from("y\n"));
    expect(execs[1]!.written.map((bytes) => bytes.toString("utf8"))).toEqual(["y\n"]);

    execs[1]!.finish(0);
    await interactive.result;
  });

  it("refuses an identity that does not own the command", async () => {
    const managerInstance = manager();
    const session = await managerInstance.run(
      "user-abc",
      { command: "cat", interactive: true },
      () => {},
    );

    await expect(managerInstance.write(session.id, "user-other", Buffer.from("x"))).rejects.toThrow(
      /No running command/,
    );

    docker.byIdentity("user-abc").commandExec().finish(0);
    await session.result;
  });

  it("refuses a command that already finished", async () => {
    const managerInstance = manager();
    const session = await managerInstance.run(
      "user-abc",
      { command: "cat", interactive: true },
      () => {},
    );
    docker.byIdentity("user-abc").commandExec().finish(0);
    await session.result;

    await expect(managerInstance.write(session.id, "user-abc", Buffer.from("x"))).rejects.toThrow(
      /No running command/,
    );
  });

  it("sends control bytes through unchanged", async () => {
    const managerInstance = manager();
    const session = await managerInstance.run(
      "user-abc",
      { command: "sleep 100", interactive: true },
      () => {},
    );

    await managerInstance.write(session.id, "user-abc", Buffer.from("\x03"));

    const exec = docker.byIdentity("user-abc").commandExec();
    expect(exec.written).toEqual([Buffer.from([0x03])]);

    exec.finish(130);
    await session.result;
  });
});

describe("remove / stop", () => {
  it("removes the container and leaves the directory", async () => {
    await manager().ensure("council-abcd");
    const dir = path.join(workspaces, "council-abcd");
    await fs.writeFile(path.join(dir, "work.md"), "x");

    expect(await manager().remove("council-abcd")).toBe(true);

    expect(docker.byIdentity("council-abcd").removed).toBe(true);
    expect(await fs.readFile(path.join(dir, "work.md"), "utf8")).toBe("x");
  });

  it("reports a container that was not there", async () => {
    expect(await manager().remove("council-missing")).toBe(false);
  });

  it("stops a container without touching its directory", async () => {
    const container = (await manager().ensure("user-abc")) as FakeContainer;

    expect(await manager().stop("user-abc")).toBe(true);

    expect(container.running).toBe(false);
    expect(container.removed).toBe(false);
  });
});

describe("sweep and reapIdle", () => {
  it("stops containers a previous process left running", async () => {
    await manager().ensure("user-a");
    await manager().ensure("council-b");

    const stopped = await manager().sweep();

    expect(stopped).toBe(2);
    expect(docker.byIdentity("user-a").running).toBe(false);
    expect(docker.byIdentity("council-b").running).toBe(false);
  });

  it("stops a container idle past SANDBOX_IDLE_MINUTES", async () => {
    let clock = Date.parse("2026-01-01T01:00:00Z");
    const managerInstance = manager(() => clock);
    await managerInstance.ensure("user-abc");

    // Not idle yet.
    clock += 30 * 60_000;
    expect(await managerInstance.reapIdle()).toEqual({ stopped: 0, removed: 0 });

    clock += 40 * 60_000;
    expect(await managerInstance.reapIdle()).toEqual({ stopped: 1, removed: 0 });
    expect(docker.byIdentity("user-abc").running).toBe(false);
  });

  it("removes a container past SANDBOX_CONTAINER_TTL_DAYS", async () => {
    const created = Date.parse("2026-01-01T00:00:00Z");
    const managerInstance = manager(() => created + 8 * 86_400_000);
    await managerInstance.ensure("user-abc");

    expect(await managerInstance.reapIdle()).toEqual({ stopped: 0, removed: 1 });
    expect(docker.byIdentity("user-abc").removed).toBe(true);
  });

  it("never reaps a container an operator pinned with a zero limit", async () => {
    vi.stubEnv("SANDBOX_CONTAINER_TTL_DAYS", "0");
    vi.stubEnv("SANDBOX_IDLE_MINUTES", "0");
    config = sandboxConfig();
    const managerInstance = manager(() => Date.parse("2027-01-01T00:00:00Z"));
    await managerInstance.ensure("user-abc");

    // idleMinutes 0 still stops an idle container; TTL 0 disables removal.
    expect((await managerInstance.reapIdle()).removed).toBe(0);
  });
});

describe("identityForSlug", () => {
  it("maps a preview slug back to the workspace it was hashed from", async () => {
    const managerInstance = manager();
    await managerInstance.ensure("user-abc");

    expect(await managerInstance.identityForSlug(previewIdentitySlug("user-abc"))).toBe("user-abc");
    expect(await managerInstance.identityForSlug(previewIdentitySlug("user-other"))).toBeNull();
  });

  it("lists containers once for a burst of requests", async () => {
    const list = vi.spyOn(docker, "listContainers");
    const managerInstance = manager();
    await managerInstance.ensure("user-abc");
    list.mockClear();

    const slug = previewIdentitySlug("user-abc");
    await managerInstance.identityForSlug(slug);
    await managerInstance.identityForSlug(slug);
    expect(list).toHaveBeenCalledTimes(1);

    // A container created since the list was read is found on the next read.
    await managerInstance.ensure("user-xyz");
    expect(await managerInstance.identityForSlug(previewIdentitySlug("user-xyz"))).toBe("user-xyz");
  });
});

describe("envList", () => {
  it("serialises variables for docker exec", () => {
    expect(envList({ GH_TOKEN: "abc", NPM_TOKEN: "x=y" })).toEqual([
      "GH_TOKEN=abc",
      "NPM_TOKEN=x=y",
    ]);
  });

  it("refuses a name that is not a shell variable", () => {
    for (const name of ["lower", "1LEADING", "WITH-DASH", "SPACE HERE", "A".repeat(65)]) {
      expect(() => envList({ [name]: "x" })).toThrow(SandboxRequestError);
    }
  });

  it("refuses a NUL byte in a value", () => {
    expect(() => envList({ GH_TOKEN: "a\0b" })).toThrow(/NUL/);
  });

  it("caps the count and the total size", () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V_${i}`, "x"]));
    expect(() => envList(many)).toThrow(/At most 32/);
    expect(() => envList({ BIG: "x".repeat(32 * 1024 + 1) })).toThrow(/exceed/);
  });
});

describe("confineCwd", () => {
  const home = () => path.join(config.workspacesDir, "user-abc");

  it("defaults to the workspace and accepts a path inside it", () => {
    expect(confineCwd("user-abc", undefined, config)).toBe(home());
    expect(confineCwd("user-abc", `${home()}/src`, config)).toBe(`${home()}/src`);
  });

  it("refuses another identity's directory", () => {
    expect(() =>
      confineCwd("user-abc", path.join(config.workspacesDir, "user-other"), config),
    ).toThrow(SandboxRequestError);
    expect(() => confineCwd("user-abc", `${home()}/../user-other`, config)).toThrow(
      SandboxRequestError,
    );
    expect(() => confineCwd("user-abc", "/etc", config)).toThrow(SandboxRequestError);
  });
});
