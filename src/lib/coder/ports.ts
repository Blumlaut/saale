/**
 * The ports a coder chat's worktree is listening on.
 *
 * A port is only ever attributed to a chat when the process behind it runs
 * inside that chat's worktree, so two chats in one project cannot see each
 * other's dev servers even though they share a container. The preview URL is
 * minted here, which also makes this the one place that decides whether a
 * deployment has previews at all.
 */

import { isConfigured, killPort, listPorts, type SandboxPort } from "@/lib/sandbox/client";
import { userIdentity } from "@/lib/sandbox/identity";
import { previewConfig, previewUrl } from "@/lib/preview/url";
import { resolveTerminalTarget } from "./terminal";

/** One port as the panel shows it. */
export interface CoderPort {
  port: number;
  address: string;
  /** Bound to loopback: nothing outside the container can reach it. */
  loopback: boolean;
  pid: number | null;
  command: string | null;
  /** Null when previews are off, or when the port cannot be proxied. */
  url: string | null;
}

/** Everything the Ports tab needs in one answer. */
export interface ChatPorts {
  enabled: boolean;
  domain: string | null;
  ports: CoderPort[];
}

/** Whether a process's directory is inside the worktree. */
function isInside(cwd: string | null, root: string): boolean {
  if (!cwd) return false;
  return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * The chat's ports, and the preview URL for each.
 *
 * Null means the chat itself is not there; a chat without a worktree throws the
 * terminal's "not ready" error, because both panels wait for the same thing.
 */
export async function listChatPorts(userId: string, sessionId: string): Promise<ChatPorts | null> {
  if (!isConfigured()) throw new SandboxUnavailableError();
  const target = await resolveTerminalTarget(userId, sessionId);
  if (!target) return null;

  const { domain } = previewConfig();
  const identity = userIdentity(userId);
  const found = await listPorts(identity);

  return {
    enabled: domain !== null,
    domain,
    ports: found
      .filter((entry) => isInside(entry.cwd, target.cwd))
      .map((entry) => toCoderPort(entry, identity)),
  };
}

/** One URL failing to build must not take the rest of the list down with it. */
function urlOrNull(identity: string, port: number): string | null {
  try {
    return previewUrl(identity, port);
  } catch (err) {
    console.error(`Failed to build the preview URL for port ${port}:`, err);
    return null;
  }
}

function toCoderPort(entry: SandboxPort, identity: string): CoderPort {
  const { domain } = previewConfig();
  // A loopback bind cannot be reached from the proxy either, so it gets no link.
  const url = domain && !entry.loopback ? urlOrNull(identity, entry.port) : null;

  return {
    port: entry.port,
    address: entry.address,
    loopback: entry.loopback,
    pid: entry.pid,
    command: entry.command,
    url,
  };
}

/**
 * Stop one of the chat's ports.
 *
 * The ownership check runs again here rather than trusting the number from the
 * request: a port that is not in this worktree is not this chat's to stop.
 */
export async function killChatPort(
  userId: string,
  sessionId: string,
  port: number,
): Promise<{ port: number; killed: boolean } | null> {
  if (!isConfigured()) throw new SandboxUnavailableError();
  const target = await resolveTerminalTarget(userId, sessionId);
  if (!target) return null;

  const identity = userIdentity(userId);
  const entry = (await listPorts(identity)).find((candidate) => candidate.port === port);
  if (!entry || !isInside(entry.cwd, target.cwd)) {
    throw new UnknownChatPortError(port);
  }

  const result = await killPort(identity, port);
  return { port: result.port, killed: result.killed };
}

/** A deployment without a sandbox service has nowhere to look for ports. */
export class SandboxUnavailableError extends Error {
  constructor() {
    super("Commands are off on this instance, so there is nothing to preview");
    this.name = "SandboxUnavailableError";
  }
}

export class UnknownChatPortError extends Error {
  constructor(port: number) {
    super(`Nothing in this worktree is listening on port ${port}`);
    this.name = "UnknownChatPortError";
  }
}
