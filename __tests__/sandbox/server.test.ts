import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxConfig } from "@/lib/sandbox/config";
import { createSandboxServer } from "@/sandbox/server";
import {
  SandboxRequestError,
  type ContainerManager,
  type SandboxChunk,
  type SandboxExecRequest,
} from "@/sandbox/containers";
import { ExecStdinClosedError, UnknownExecError } from "@/sandbox/registry";

/** A manager that runs whatever it is handed, scripted per test. */
function fakeManager(script: (request: SandboxExecRequest) => SandboxChunk[]): ContainerManager & {
  calls: SandboxExecRequest[];
  killed: string[];
  removed: string[];
  input: { id: string; identity: string; data: string }[];
} {
  const calls: SandboxExecRequest[] = [];
  const killed: string[] = [];
  const removed: string[] = [];
  const input: { id: string; identity: string; data: string }[] = [];

  return {
    calls,
    killed,
    removed,
    input,
    async ensure() {
      throw new Error("not used");
    },
    async run(identity, request, onChunk) {
      calls.push({ ...request, identity } as SandboxExecRequest);
      for (const chunk of script(request)) onChunk(chunk);
      return {
        id: "exec-1",
        result: Promise.resolve({ exitCode: 0, timedOut: false, durationMs: 4 }),
      };
    },
    async kill(id) {
      if (id === "unknown") throw new UnknownExecError(id);
      killed.push(id);
    },
    async write(id, identity, data) {
      if (id === "unknown") throw new UnknownExecError(id);
      if (id === "closed") throw new ExecStdinClosedError(id);
      input.push({ id, identity, data: data.toString("utf8") });
    },
    async remove(identity) {
      removed.push(identity);
      return true;
    },
    async stop() {
      return true;
    },
    async sweep() {
      return 0;
    },
    async reapIdle() {
      return { stopped: 0, removed: 0 };
    },
    async identityForSlug() {
      return null;
    },
  };
}

let server: http.Server;
let baseUrl: string;
let config = sandboxConfig();

async function start(manager: ContainerManager): Promise<void> {
  config = { ...sandboxConfig(), apiKey: "test-key" };
  server = createSandboxServer({ manager, config });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", "/workspaces");
});

/** Execute a command and collect the SSE events the service sends. */
async function execCommand(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; events: Array<{ event: string; data: Record<string, unknown> }> }> {
  const response = await fetch(`${baseUrl}/exec`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "X-Identity": "user-abc",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  if (!response.headers.get("content-type")?.includes("event-stream")) {
    return { status: response.status, events: [] };
  }

  const text = await response.text();
  const events = text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const event =
        lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "";
      const data = JSON.parse(
        lines
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
          .trim() ?? "{}",
      ) as Record<string, unknown>;
      return { event, data };
    });

  return { status: response.status, events };
}

describe("GET /health", () => {
  it("answers without the key, so a healthcheck needs no secret", async () => {
    await start(fakeManager(() => []));

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("POST /exec", () => {
  it("streams started, the output chunks and the exit code", async () => {
    await start(
      fakeManager(() => [
        { stream: "stdout", data: Buffer.from("hello\n") },
        { stream: "stderr", data: Buffer.from("careful\n") },
      ]),
    );

    const { status, events } = await execCommand({ command: "echo hello" });

    expect(status).toBe(200);
    expect(events.map((event) => event.event)).toEqual(["started", "chunk", "chunk", "exit"]);
    expect(events[0]!.data).toEqual({ execId: "exec-1" });
    expect(events[1]!.data).toEqual({
      stream: "stdout",
      data: Buffer.from("hello\n").toString("base64"),
    });
    expect(events[2]!.data).toEqual({
      stream: "stderr",
      data: Buffer.from("careful\n").toString("base64"),
    });
    expect(events[3]!.data).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it("refuses a request without the key", async () => {
    await start(fakeManager(() => []));

    const response = await fetch(`${baseUrl}/exec`, {
      method: "POST",
      headers: { "X-Identity": "user-abc", "Content-Type": "application/json" },
      body: JSON.stringify({ command: "ls" }),
    });

    expect(response.status).toBe(401);
  });

  it("refuses a request naming no identity", async () => {
    const manager = fakeManager(() => []);
    await start(manager);

    const response = await fetch(`${baseUrl}/exec`, {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ command: "ls" }),
    });

    expect(response.status).toBe(400);
    expect(manager.calls).toHaveLength(0);
  });

  it("refuses an identity shaped like a path", async () => {
    const manager = fakeManager(() => []);
    await start(manager);

    const { status } = await execCommand({ command: "ls" }, { "X-Identity": "../user-other" });

    expect(status).toBe(400);
    expect(manager.calls).toHaveLength(0);
  });

  it("refuses a body without a command", async () => {
    await start(fakeManager(() => []));

    const { status } = await execCommand({});

    expect(status).toBe(400);
  });

  it("refuses env that is not a flat string map", async () => {
    await start(fakeManager(() => []));

    expect((await execCommand({ command: "ls", env: "GH_TOKEN=x" })).status).toBe(400);
    expect((await execCommand({ command: "ls", env: { GH_TOKEN: 1 } })).status).toBe(400);
  });

  it("hands the manager the command, cwd, env and timeout", async () => {
    const manager = fakeManager(() => []);
    await start(manager);

    await execCommand({
      command: "pwd",
      cwd: "/workspaces/user-abc/src",
      env: { GH_TOKEN: "x" },
      timeoutSeconds: 30,
    });

    expect(manager.calls[0]).toMatchObject({
      command: "pwd",
      cwd: "/workspaces/user-abc/src",
      env: { GH_TOKEN: "x" },
      timeoutSeconds: 30,
    });
  });

  it("reports a refused request as JSON when the stream never opened", async () => {
    const manager: ContainerManager = {
      ...fakeManager(() => []),
      async run() {
        throw new SandboxRequestError("Working directory is outside the workspace", 400);
      },
    };
    await start(manager);

    const response = await fetch(`${baseUrl}/exec`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "X-Identity": "user-abc",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command: "ls", cwd: "/etc" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("outside"),
    });
  });
});

describe("DELETE /exec/:id", () => {
  it("signals the command's group", async () => {
    const manager = fakeManager(() => []);
    await start(manager);

    const response = await fetch(`${baseUrl}/exec/exec-1`, {
      method: "DELETE",
      headers: { Authorization: "Bearer test-key" },
    });

    expect(response.status).toBe(200);
    expect(manager.killed).toEqual(["exec-1"]);
  });

  it("404s a command it does not know, which is how a finished command reads", async () => {
    await start(fakeManager(() => []));

    const response = await fetch(`${baseUrl}/exec/unknown`, {
      method: "DELETE",
      headers: { Authorization: "Bearer test-key" },
    });

    expect(response.status).toBe(404);
  });
});

describe("POST /exec/:id/input", () => {
  async function write(
    id: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}/exec/${id}/input`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "X-Identity": "user-abc",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it("decodes base64 and hands the bytes to the command", async () => {
    const manager = fakeManager(() => []);
    await start(manager);

    const response = await write("exec-1", {
      data: Buffer.from("npm test\n").toString("base64"),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ written: 9 });
    expect(manager.input).toEqual([{ id: "exec-1", identity: "user-abc", data: "npm test\n" }]);
  });

  it("sends control bytes unchanged, so a ctrl-c keystroke survives", async () => {
    const manager = fakeManager(() => []);
    await start(manager);

    await write("exec-1", { data: Buffer.from("\x03").toString("base64") });

    expect(manager.input[0]?.data).toBe("\x03");
  });

  it("refuses a write to a command of another identity", async () => {
    const manager: ContainerManager = {
      ...fakeManager(() => []),
      async write(id) {
        throw new UnknownExecError(id);
      },
    };
    await start(manager);

    const response = await write("exec-other", { data: "aGk=" });

    expect(response.status).toBe(404);
  });

  it("409s a command running without stdin", async () => {
    await start(fakeManager(() => []));

    const response = await write("closed", { data: "aGk=" });

    expect(response.status).toBe(409);
  });

  it("refuses a body without data", async () => {
    await start(fakeManager(() => []));

    const response = await write("exec-1", {});

    expect(response.status).toBe(400);
  });

  it("requires the key", async () => {
    await start(fakeManager(() => []));

    const response = await fetch(`${baseUrl}/exec/exec-1/input`, {
      method: "POST",
      headers: { "X-Identity": "user-abc" },
      body: JSON.stringify({ data: "aGk=" }),
    });

    expect(response.status).toBe(401);
  });
});

describe("DELETE /container/:id", () => {
  it("removes an identity's container and leaves its directory to the caller", async () => {
    const manager = fakeManager(() => []);
    await start(manager);

    const response = await fetch(`${baseUrl}/container/council-abcd`, {
      method: "DELETE",
      headers: { Authorization: "Bearer test-key" },
    });

    expect(response.status).toBe(200);
    expect(manager.removed).toEqual(["council-abcd"]);
    await expect(response.json()).resolves.toEqual({ removed: true });
  });

  it("requires the key", async () => {
    await start(fakeManager(() => []));

    const response = await fetch(`${baseUrl}/container/council-abcd`, { method: "DELETE" });

    expect(response.status).toBe(401);
  });
});

describe("unknown routes", () => {
  it("404s, rather than falling through to a container call", async () => {
    await start(fakeManager(() => []));

    const response = await fetch(`${baseUrl}/whatever`, {
      headers: { Authorization: "Bearer test-key" },
    });

    expect(response.status).toBe(404);
  });
});

describe("the port routes", () => {
  const HEADER =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const LISTENING = `   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 21011 1 0000000000000000 100 0 0 10 0`;

  /** The three reads discovery makes, answered per command. */
  const discovery = (request: SandboxExecRequest): SandboxChunk[] => {
    if (request.command.includes("/proc/net/tcp")) {
      return [{ stream: "stdout", data: Buffer.from(`${HEADER}\n${LISTENING}`) }];
    }
    if (request.command.startsWith("ls -l")) {
      return [
        {
          stream: "stdout",
          data: Buffer.from(
            "/proc/120/fd:\ntotal 0\nlrwx------ 1 root root 64 Oct 23 14:00 3 -> socket:[21011]",
          ),
        },
      ];
    }
    if (request.command.startsWith("for p in")) {
      return [
        {
          stream: "stdout",
          data: Buffer.from(
            "120\t/workspaces/user-abc/worktrees/saale/c-1\tnode vite --host 0.0.0.0\n",
          ),
        },
      ];
    }
    return [{ stream: "stdout", data: Buffer.from("killed\n") }];
  };

  it("lists what the workspace is listening on", async () => {
    await start(fakeManager(discovery));

    const response = await fetch(`${baseUrl}/ports`, {
      headers: { Authorization: "Bearer test-key", "X-Identity": "user-abc" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ports: [
        {
          port: 8080,
          address: "0.0.0.0",
          loopback: false,
          pid: 120,
          command: "node vite --host 0.0.0.0",
          cwd: "/workspaces/user-abc/worktrees/saale/c-1",
        },
      ],
    });
  });

  it("refuses to list ports without the key", async () => {
    await start(fakeManager(discovery));

    const response = await fetch(`${baseUrl}/ports`, { headers: { "X-Identity": "user-abc" } });
    expect(response.status).toBe(401);
  });

  it("stops the process listening on a port", async () => {
    const manager = fakeManager(discovery);
    await start(manager);

    const response = await fetch(`${baseUrl}/ports/8080/kill`, {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "X-Identity": "user-abc" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ port: 8080, pid: 120, killed: true });
    expect(manager.calls.at(-1)?.command).toContain("kill -TERM 120");
  });

  it("answers 404 for a port that is not listening", async () => {
    await start(fakeManager(discovery));

    const response = await fetch(`${baseUrl}/ports/9999/kill`, {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "X-Identity": "user-abc" },
    });

    expect(response.status).toBe(404);
  });
});
