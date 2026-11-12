/**
 * MCP over stdio, with the server program in the owner's workspace container.
 *
 * The agent process never spawns a tenant's command: Pi's MCP extension asks for
 * a transport, and this one starts the command through `sandbox-exec` and pipes
 * JSON-RPC to its stdin and stdout. The container is the isolation boundary, the
 * same one the terminal tools run in, so a server sees the workspace and the
 * user's own variables and nothing of the app's.
 */

import path from "node:path";
import { McpClient, PipeTransport, type McpPipe } from "@earendil-works/pi-mcp";
import { requireWithinRoot } from "@/lib/files/paths";
import { exec, kill, writeInput } from "@/lib/sandbox/client";
import { resolveSandboxEnv } from "@/lib/sandbox/env";
import { userIdentity } from "@/lib/sandbox/identity";
import { userWorkspacePath } from "@/lib/sandbox/workspace";
import type { McpProbeResult } from "./probe";

/** How one configured stdio server is started. */
export interface WorkspaceCommand {
  userId: string;
  /** The server's name, for log lines and error messages. */
  name: string;
  /** A command line, run by bash in the container. */
  command: string;
  /** Working directory, relative to the workspace root. The root when null. */
  cwd: string | null;
  /** The server's own variables, over the account's. */
  env?: Record<string, string>;
  /** The chat the command belongs to, so evicting it can end the command. */
  sessionId?: string;
  /** How long the command may take to exit after stdin closes. */
  closeTimeoutMs?: number;
}

/**
 * Commands a session's servers started, so an eviction can end them.
 *
 * A pooled session is dropped with `session.dispose()`, which does not emit the
 * extension's `session_shutdown`, so the MCP extension never closes these
 * connections. Without this a chat that changes its servers, or simply ages out
 * of the pool, leaves one program per server running in the container until it
 * stops.
 *
 * Anchored on `globalThis` because Next builds a server module into a bundle per
 * route: a map that lives in one copy is invisible to the route that evicts the
 * chat, and the command would outlive it.
 */
const registry = globalThis as unknown as { saaleMcpCommands?: Map<string, Set<() => void>> };
const runningBySession = (registry.saaleMcpCommands ??= new Map<string, Set<() => void>>());

function trackCommand(sessionId: string, stop: () => void): () => void {
  const stops = runningBySession.get(sessionId) ?? new Set<() => void>();
  stops.add(stop);
  runningBySession.set(sessionId, stops);

  return () => {
    stops.delete(stop);
    if (stops.size === 0) runningBySession.delete(sessionId);
  };
}

/** End every command one session's MCP servers started. */
export function stopWorkspaceCommands(sessionId: string): void {
  const stops = runningBySession.get(sessionId);
  runningBySession.delete(sessionId);
  for (const stop of stops ?? []) stop();
}

/**
 * Where the command starts.
 *
 * The service confines the path to the workspace as well; refusing it here keeps
 * a value that would be refused at connect time from being stored.
 */
export function workspaceCommandCwd(userId: string, cwd: string | null): string {
  const root = userWorkspacePath(userId);
  if (!cwd) return root;
  return requireWithinRoot(root, path.posix.resolve(root, cwd));
}

/**
 * The transport for a stdio server.
 *
 * The program's stdin has no half-close over Docker (`writeInput` says so), so
 * `closeStdin` does nothing and PipeTransport's shutdown timeout is what ends the
 * command.
 */
export function createWorkspaceMcpTransport(options: WorkspaceCommand): PipeTransport {
  const identity = userIdentity(options.userId);

  return new PipeTransport({
    ...(options.closeTimeoutMs ? { closeTimeoutMs: options.closeTimeoutMs } : {}),
    open: async (handlers): Promise<McpPipe> => {
      const env = { ...(await resolveSandboxEnv(options.userId)), ...options.env };
      const cwd = workspaceCommandCwd(options.userId, options.cwd);

      const events = exec({
        identity,
        command: options.command,
        cwd,
        env,
        // Attached stdin is what `writeInput` types into.
        interactive: true,
      });

      const first = await events.next();
      if (first.done || first.value.type !== "started") {
        throw new Error(`The command for MCP server "${options.name}" did not start.`);
      }
      const { execId } = first.value;

      const stop = () => {
        void kill(execId).catch((err: unknown) => {
          console.error(`Failed to stop MCP server "${options.name}":`, err);
        });
      };
      const untrack = options.sessionId ? trackCommand(options.sessionId, stop) : () => {};

      let settle!: (exitCode: number | null) => void;
      let fail!: (err: unknown) => void;
      const exited = new Promise<number | null>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });

      // Drain the rest of the stream: the service sends the program's output as
      // it arrives and ends with an exit event.
      void (async () => {
        let settled = false;
        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          untrack();
          settle(exitCode);
        };

        try {
          for await (const event of events) {
            if (event.type === "chunk") {
              if (event.stream === "stdout") handlers.onStdout(event.data);
              else handlers.onStderr(event.data);
            } else if (event.type === "exit") {
              finish(event.exitCode);
            }
          }
          // The stream dropped without an exit event: the command is gone either
          // way, and a pipe must not wait forever.
          finish(null);
        } catch (err) {
          console.error(`MCP server "${options.name}" (${identity}) stopped:`, err);
          fail(err);
        }
      })();

      // Messages must reach the program in order, and each write is its own
      // request to the service, so they go one at a time.
      let writes: Promise<void> = Promise.resolve();

      return {
        write(data) {
          const bytes = typeof data === "string" ? data : Buffer.from(data);
          writes = writes
            .then(() => writeInput(execId, identity, bytes))
            .catch((err: unknown) => {
              console.error(`Failed to write to MCP server "${options.name}":`, err);
            });
        },
        closeStdin() {
          // Docker cannot half-close a hijacked connection.
        },
        close() {
          untrack();
          stop();
        },
        exited,
      };
    },
  });
}

/** Characters of the program's stderr an error message keeps. */
const STDERR_TAIL_CHARS = 600;

/**
 * How long a probed command may take to exit before it is killed.
 *
 * A probe ends with a kill anyway: stdin has no half-close over Docker, so
 * waiting for the shutdown the spec describes only makes the settings page wait.
 */
const PROBE_CLOSE_TIMEOUT_MS = 500;

/**
 * Connect to a stdio server and list what it offers.
 *
 * The transport is opened directly rather than through the MCP extension, so the
 * settings page can test a command before anything is stored. A command that
 * dies speaks through stderr (`npm ERR!`, a missing module), which is the part
 * the user can act on, so it travels with the error.
 */
export async function probeStdioMcpServer(
  command: WorkspaceCommand,
  options: { timeoutMs: number },
): Promise<McpProbeResult> {
  const client = new McpClient({
    name: "saale",
    version: "1",
    requestTimeoutMs: options.timeoutMs,
  });
  const transport = createWorkspaceMcpTransport({
    ...command,
    closeTimeoutMs: PROBE_CLOSE_TIMEOUT_MS,
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    return {
      serverName: client.serverInfo?.name ?? null,
      serverVersion: client.serverInfo?.version ?? null,
      instructions: client.instructions ?? null,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? null,
      })),
    };
  } catch (err) {
    throw describeCommandFailure(err, transport.stderr, command.name);
  } finally {
    await client.close().catch((err: unknown) => {
      console.error("Failed to close the MCP probe connection:", err);
    });
  }
}

/** The failure the settings page shows, with the program's own last words. */
function describeCommandFailure(err: unknown, stderr: string, name: string): Error {
  const reason = err instanceof Error ? err.message : String(err);
  const tail = stderr.trim().slice(-STDERR_TAIL_CHARS);
  const message = tail
    ? `The command for "${name}" ${reason}\n${tail}`
    : `The command for "${name}" ${reason}`;
  return new Error(message);
}
