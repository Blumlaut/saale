import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exec,
  isConfigured,
  kill,
  removeContainer,
  SandboxApiError,
  writeInput,
} from "@/lib/sandbox/client";
import type { SandboxEvent } from "@/lib/sandbox/client";

/** A response whose body streams the given SSE frames. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function collect(options: Parameters<typeof exec>[0]): Promise<SandboxEvent[]> {
  const events: SandboxEvent[] = [];
  for await (const event of exec(options)) events.push(event);
  return events;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("SANDBOX_URL", "http://sandbox-exec:8100/");
  vi.stubEnv("SANDBOX_API_KEY", "test-key");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

describe("isConfigured", () => {
  it("is true only when the URL and the key are both there", () => {
    expect(isConfigured()).toBe(true);
    vi.stubEnv("SANDBOX_API_KEY", "");
    expect(isConfigured()).toBe(false);
    vi.stubEnv("SANDBOX_API_KEY", "test-key");
    vi.stubEnv("SANDBOX_URL", "");
    expect(isConfigured()).toBe(false);
  });
});

describe("exec", () => {
  it("sends the identity and the key, and parses the event stream", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        frame("started", { execId: "exec-1" }),
        frame("chunk", { stream: "stdout", data: Buffer.from("hello\n").toString("base64") }),
        frame("chunk", { stream: "stderr", data: Buffer.from("careful\n").toString("base64") }),
        frame("exit", { exitCode: 0, timedOut: false, durationMs: 12 }),
      ]),
    );

    const events = await collect({ identity: "user-abc", command: "echo hello" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://sandbox-exec:8100/exec");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "X-Identity": "user-abc",
    });
    expect(JSON.parse(init.body)).toEqual({ command: "echo hello" });

    expect(events).toEqual([
      { type: "started", execId: "exec-1" },
      { type: "chunk", stream: "stdout", data: Buffer.from("hello\n") },
      { type: "chunk", stream: "stderr", data: Buffer.from("careful\n") },
      { type: "exit", exitCode: 0, timedOut: false, durationMs: 12 },
    ]);
  });

  it("forwards cwd, env and the timeout only when they are given", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 })]),
    );

    await collect({ identity: "user-abc", command: "pwd" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ command: "pwd" });

    fetchMock.mockResolvedValue(
      sseResponse([frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 })]),
    );
    await collect({
      identity: "user-abc",
      command: "env",
      cwd: "/workspaces/user-abc/src",
      env: { GH_TOKEN: "x" },
      timeoutSeconds: 30,
    });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      command: "env",
      cwd: "/workspaces/user-abc/src",
      env: { GH_TOKEN: "x" },
      timeoutSeconds: 30,
    });
  });

  it("reassembles a frame split across network chunks", async () => {
    const whole =
      frame("started", { execId: "exec-1" }) +
      frame("exit", { exitCode: 3, timedOut: true, durationMs: 5 });
    const cut = 10;
    fetchMock.mockResolvedValue(
      sseResponse([whole.slice(0, cut), whole.slice(cut, cut + 20), whole.slice(cut + 20)]),
    );

    const events = await collect({ identity: "user-abc", command: "sleep 100" });

    expect(events).toEqual([
      { type: "started", execId: "exec-1" },
      { type: "exit", exitCode: 3, timedOut: true, durationMs: 5 },
    ]);
  });

  it("kills the command when the caller aborts", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();

    fetchMock.mockImplementation(async (url: string) => {
      if (!url.endsWith("/exec")) {
        return new Response(JSON.stringify({ killed: true }), { status: 200 });
      }
      // Announces the command, then keeps the stream open so the abort is what
      // ends the iteration.
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(encoder.encode(frame("started", { execId: "exec-1" })));
          controller.signal.addEventListener("abort", () => {
            streamController.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(body, { status: 200 });
    });

    const events: SandboxEvent[] = [];
    const iterate = (async () => {
      for await (const event of exec({
        identity: "user-abc",
        command: "sleep 100",
        signal: controller.signal,
      })) {
        events.push(event);
      }
    })();

    await vi.waitFor(() => expect(events).toHaveLength(1));
    controller.abort();

    await expect(iterate).rejects.toThrow();
    await vi.waitFor(() => {
      const killCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/exec/exec-1"));
      expect(killCall?.[1]).toMatchObject({ method: "DELETE" });
    });
  });

  it("asks for stdin only when the command is interactive", async () => {
    fetchMock.mockResolvedValue(sseResponse([frame("exit", { exitCode: 0, durationMs: 1 })]));

    await collect({ identity: "user-abc", command: "ls" });
    await collect({ identity: "user-abc", command: "npm init", interactive: true });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ command: "ls" });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      command: "npm init",
      interactive: true,
    });
  });

  it("reports a service error with its status and body", async () => {
    fetchMock.mockImplementation(async () => new Response("no such identity", { status: 400 }));

    await expect(collect({ identity: "user-abc", command: "ls" })).rejects.toBeInstanceOf(
      SandboxApiError,
    );
    await expect(collect({ identity: "user-abc", command: "ls" })).rejects.toThrow(
      /sandbox-exec 400: no such identity/,
    );
  });

  it("skips a frame it cannot parse instead of dying mid-stream", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      sseResponse([
        frame("started", { execId: "exec-1" }),
        "event: chunk\ndata: not-json\n\n",
        frame("exit", { exitCode: 0, timedOut: false, durationMs: 1 }),
      ]),
    );

    const events = await collect({ identity: "user-abc", command: "ls" });

    expect(events.map((event) => event.type)).toEqual(["started", "exit"]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("writeInput", () => {
  it("sends the keystrokes base64-encoded, so control bytes survive", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ written: 1 }), { status: 200 }));

    await writeInput("exec-1", "user-abc", "\x03");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://sandbox-exec:8100/exec/exec-1/input");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "X-Identity": "user-abc" });
    expect(JSON.parse(init.body)).toEqual({ data: Buffer.from("\x03").toString("base64") });
  });

  it("reports a command that is no longer running", async () => {
    fetchMock.mockResolvedValue(new Response("No running command exec-1", { status: 404 }));

    await expect(writeInput("exec-1", "user-abc", "x")).rejects.toBeInstanceOf(SandboxApiError);
  });
});

describe("kill / removeContainer", () => {
  it("treats a command that already finished as done", async () => {
    fetchMock.mockResolvedValue(new Response("gone", { status: 404 }));

    await expect(kill("exec-1")).resolves.toBeUndefined();
  });

  it("removes an identity's container by name", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ removed: true }), { status: 200 }));

    await removeContainer("council-abcd");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://sandbox-exec:8100/container/council-abcd");
    expect(init.method).toBe("DELETE");
  });
});
