/**
 * The `sandbox-exec` service.
 *
 * A small HTTP API the app calls to run a command in an identity's container.
 * `POST /exec` streams output as server-sent events, `DELETE /exec/:id` stops a
 * command. Both are keyed on an identity, never on a path.
 *
 * It holds the Docker socket, so it is as privileged as the host it runs on.
 * Only web and worker talk to it, with a shared bearer key.
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import Docker from "dockerode";
import { sandboxConfig, type SandboxConfig } from "@/lib/sandbox/config";
import { parseIdentity, InvalidSandboxIdentityError } from "@/lib/sandbox/identity";
import { sweepWorkspaceTmp } from "@/lib/sandbox/tmp";
import {
  asDockerHandle,
  createContainerManager,
  SandboxRequestError,
  type ContainerManager,
  type SandboxChunk,
} from "./containers";
import { UnknownExecError } from "./registry";

/** Largest request body accepted. An exec body holds a command and its env. */
const MAX_BODY_BYTES = 1024 * 1024;

/** How often idle containers are reaped. */
const REAP_INTERVAL_MS = 60_000;

export interface SandboxServerOptions {
  manager: ContainerManager;
  config: SandboxConfig;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "Request body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

function authorized(req: http.IncomingMessage, config: SandboxConfig): boolean {
  if (!config.apiKey) return false;
  const header = req.headers.authorization;
  return header === `Bearer ${config.apiKey}`;
}

function identityFrom(req: http.IncomingMessage): string {
  const header = req.headers["x-identity"];
  const raw = Array.isArray(header) ? header[0] : header;
  try {
    return parseIdentity(raw);
  } catch (err) {
    if (err instanceof InvalidSandboxIdentityError) throw new HttpError(400, err.message);
    throw err;
  }
}

function asExecRequest(body: Record<string, unknown>): {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
} {
  const command = body.command;
  if (typeof command !== "string" || !command.trim()) {
    throw new HttpError(400, "command is required");
  }

  const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : undefined;

  let env: Record<string, string> | undefined;
  if (body.env !== undefined) {
    if (typeof body.env !== "object" || body.env === null || Array.isArray(body.env)) {
      throw new HttpError(400, "env must be an object of strings");
    }
    env = {};
    for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
      if (typeof value !== "string") throw new HttpError(400, `env.${key} must be a string`);
      env[key] = value;
    }
  }

  let timeoutSeconds: number | undefined;
  if (body.timeoutSeconds !== undefined) {
    if (typeof body.timeoutSeconds !== "number" || !Number.isFinite(body.timeoutSeconds)) {
      throw new HttpError(400, "timeoutSeconds must be a number");
    }
    timeoutSeconds = body.timeoutSeconds;
  }

  return {
    command,
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
  };
}

/** POST /exec: run a command, stream `started`, `chunk`s and `exit`. */
async function handleExec(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: ContainerManager,
  identity: string,
): Promise<void> {
  const request = asExecRequest(await readJson(req));

  // Nothing is written until the container is up and the exec has started: a
  // refused working directory or an image that will not start is a status code
  // the caller can act on, not a stream that ends without an exit code.
  let open = false;
  const pendingChunks: SandboxChunk[] = [];

  const writeChunk = (chunk: SandboxChunk): void => {
    res.write(sse("chunk", { stream: chunk.stream, data: chunk.data.toString("base64") }));
  };

  const session = await manager.run(identity, request, (chunk) => {
    if (open) writeChunk(chunk);
    else pendingChunks.push(chunk);
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  open = true;
  res.on("close", () => {
    open = false;
  });

  res.write(sse("started", { execId: session.id }));
  for (const chunk of pendingChunks) writeChunk(chunk);
  pendingChunks.length = 0;

  // A stop arrives on another connection; this one ends when the command does.
  const result = await session.result;
  if (!open) {
    console.warn(`[sandbox] client left, command ${session.id} finished with ${result.exitCode}`);
    return;
  }
  res.write(
    sse("exit", {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    }),
  );
  res.end();
}

export function createSandboxServer(options: SandboxServerOptions): http.Server {
  const { manager, config } = options;

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://sandbox");

        if (url.pathname === "/health") {
          json(res, 200, { status: "ok" });
          return;
        }

        if (!authorized(req, config)) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }

        if (req.method === "POST" && url.pathname === "/exec") {
          await handleExec(req, res, manager, identityFrom(req));
          return;
        }

        const execMatch = /^\/exec\/([^/]+)$/.exec(url.pathname);
        if (req.method === "DELETE" && execMatch?.[1]) {
          try {
            await manager.kill(decodeURIComponent(execMatch[1]));
          } catch (err) {
            if (err instanceof UnknownExecError) throw new HttpError(404, err.message);
            throw err;
          }
          json(res, 200, { killed: true });
          return;
        }

        const containerMatch = /^\/container\/([^/]+)$/.exec(url.pathname);
        if (req.method === "DELETE" && containerMatch?.[1]) {
          const removed = await manager.remove(decodeURIComponent(containerMatch[1]));
          json(res, 200, { removed });
          return;
        }

        json(res, 404, { error: "Not found" });
      } catch (err) {
        if (res.headersSent) {
          // The stream is already open; the exit event is the only channel
          // left, and the command's own result carries the failure.
          console.error("[sandbox] request failed after the stream opened:", err);
          res.end();
          return;
        }
        if (err instanceof HttpError) {
          json(res, err.status, { error: err.message });
          return;
        }
        if (err instanceof SandboxRequestError) {
          json(res, err.status, { error: err.message });
          return;
        }
        console.error("[sandbox] request failed:", err);
        json(res, 500, { error: err instanceof Error ? err.message : "Request failed" });
      }
    })();
  });

  // A command can legitimately run for minutes; the platform's default request
  // timeout would cut the stream.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;

  return server;
}

/** Boot: sweep what a previous process left, then serve and reap. */
async function main(): Promise<void> {
  const config = sandboxConfig();
  if (!config.apiKey) {
    console.error("[sandbox] SANDBOX_API_KEY is not set. refusing to start");
    process.exit(1);
  }

  const docker = new Docker();
  const manager = createContainerManager({ docker: asDockerHandle(docker), config });
  const server = createSandboxServer({ manager, config });

  await manager.sweep().catch((err) => {
    console.error("[sandbox] sweep at startup failed:", err);
  });

  const timer = setInterval(() => {
    void manager.reapIdle().catch((err) => {
      console.error("[sandbox] idle reaper failed:", err);
    });
    void sweepWorkspaceTmp(config.workspacesDir, {
      olderThanMs: config.tmpHours * 3_600_000,
    })
      .then((swept) => {
        if (swept.removed > 0) {
          console.warn(`[sandbox] cleared ${swept.removed} scratch file(s)`);
        }
      })
      .catch((err) => {
        console.error("[sandbox] scratch sweep failed:", err);
      });
  }, REAP_INTERVAL_MS);
  timer.unref?.();

  server.listen(config.port, () => {
    console.warn(
      `[sandbox] listening on :${config.port} (volume ${config.volume}, user ${config.user})`,
    );
  });

  const shutdown = (signal: string) => {
    console.warn(`[sandbox] ${signal} received, closing`);
    clearInterval(timer);
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only when run as the service, not when a test imports the factory.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((err) => {
    console.error("[sandbox] failed to start:", err);
    process.exit(1);
  });
}
