/**
 * Client for the `sandbox-exec` service.
 *
 * The service runs one command in one identity's container and streams what it
 * prints. `exec` is an async iterable of events because that is the shape Pi's
 * `BashOperations` wants: chunks as they arrive, then an exit code.
 *
 * The caller passes an identity and never a path: the service derives the
 * directory and the mount from it.
 */

import { sandboxConfig } from "./config";

/** A command that exited or was killed. */
export interface SandboxExit {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export type SandboxEvent =
  | { type: "started"; execId: string }
  | { type: "chunk"; stream: "stdout" | "stderr"; data: Buffer }
  | ({ type: "exit" } & SandboxExit);

export interface SandboxExecOptions {
  identity: string;
  command: string;
  /** Working directory inside the container. Confined to the workspace by the service. */
  cwd?: string;
  /** Variables for this command only. Never stored, never logged. */
  env?: Record<string, string>;
  timeoutSeconds?: number;
  /** Attach stdin, so `writeInput` can type into the command while it runs. */
  interactive?: boolean;
  signal?: AbortSignal;
}

/** A non-2xx answer from the service. */
export class SandboxApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`sandbox-exec ${status}${body ? `: ${body}` : ""}`);
    this.name = "SandboxApiError";
  }
}

/** Whether commands are available on this deployment (`SANDBOX_URL` is set). */
export function isConfigured(): boolean {
  return !!(sandboxConfig().url && sandboxConfig().apiKey);
}

function serviceUrl(): string {
  const { url } = sandboxConfig();
  if (!url) throw new Error("SANDBOX_URL is not set");
  return url.replace(/\/+$/, "");
}

function authHeaders(identity: string): Record<string, string> {
  const { apiKey } = sandboxConfig();
  if (!apiKey) throw new Error("SANDBOX_API_KEY is not set");
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-Identity": identity,
    "Content-Type": "application/json",
  };
}

async function failure(response: Response): Promise<SandboxApiError> {
  const body = await response.text().catch((err) => {
    console.error("Failed to read sandbox-exec error body:", err);
    return "";
  });
  return new SandboxApiError(response.status, body);
}

/** The service is up and the key it was given matches. */
export async function health(): Promise<{ status: string }> {
  const response = await fetch(`${serviceUrl()}/health`, {
    headers: { Authorization: `Bearer ${sandboxConfig().apiKey ?? ""}` },
  });
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<{ status: string }>;
}

/**
 * Run a command, yielding its output as the service sends it.
 *
 * An abort ends the iteration and kills the command: a `Stop` must stop the
 * process, not just stop listening to it.
 */
export async function* exec(options: SandboxExecOptions): AsyncGenerator<SandboxEvent> {
  const { identity, command, cwd, env, timeoutSeconds, interactive, signal } = options;

  const response = await fetch(`${serviceUrl()}/exec`, {
    method: "POST",
    headers: authHeaders(identity),
    body: JSON.stringify({
      command,
      ...(cwd ? { cwd } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
      ...(interactive ? { interactive: true } : {}),
    }),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) throw await failure(response);
  if (!response.body) throw new SandboxApiError(response.status, "empty response body");

  let execId: string | null = null;
  const onAbort = () => {
    if (execId)
      void kill(execId).catch((err) => console.error("Failed to kill sandbox exec:", err));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const event = parseBlock(block);
        if (!event) continue;
        if (event.type === "started") execId = event.execId;
        yield event;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseBlock(block: string): SandboxEvent | null {
  let name = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trim());
  }
  if (!name || data.length === 0) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data.join("\n")) as Record<string, unknown>;
  } catch (err) {
    console.error(`Malformed sandbox-exec event "${name}":`, err);
    return null;
  }

  if (name === "started" && typeof payload.execId === "string") {
    return { type: "started", execId: payload.execId };
  }
  if (name === "chunk" && typeof payload.data === "string") {
    return {
      type: "chunk",
      stream: payload.stream === "stderr" ? "stderr" : "stdout",
      data: Buffer.from(payload.data, "base64"),
    };
  }
  if (name === "exit") {
    return {
      type: "exit",
      exitCode: typeof payload.exitCode === "number" ? payload.exitCode : 1,
      timedOut: payload.timedOut === true,
      durationMs: typeof payload.durationMs === "number" ? payload.durationMs : 0,
    };
  }
  return null;
}

/** Signal a running command's process group. */
export async function kill(execId: string): Promise<void> {
  const response = await fetch(`${serviceUrl()}/exec/${encodeURIComponent(execId)}`, {
    method: "DELETE",
    headers: authHeaders("user-none"),
  });
  if (!response.ok && response.status !== 404) throw await failure(response);
}

/**
 * Type into a command started with `interactive`.
 *
 * There is no EOF: Docker cannot half-close a hijacked connection without
 * taking the command's output with it.
 */
export async function writeInput(execId: string, identity: string, data: Buffer | string) {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const response = await fetch(`${serviceUrl()}/exec/${encodeURIComponent(execId)}/input`, {
    method: "POST",
    headers: authHeaders(identity),
    body: JSON.stringify({ data: bytes.toString("base64") }),
  });
  if (!response.ok) throw await failure(response);
}

/** Remove an identity's container. Its directory stays. */
export async function removeContainer(identity: string): Promise<void> {
  const response = await fetch(`${serviceUrl()}/container/${encodeURIComponent(identity)}`, {
    method: "DELETE",
    headers: authHeaders(identity),
  });
  if (!response.ok && response.status !== 404) throw await failure(response);
}
