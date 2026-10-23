/**
 * The ports a workspace has open, and stopping one.
 *
 * Three execs at most: the two kernel tables and the fd listing are independent,
 * then one short command describes the processes that own a socket. A port whose
 * owner cannot be found is still reported, because the port is what a preview
 * needs and "unknown process" is better than a missing row.
 */

import type { ContainerManager } from "./containers";
import { collect } from "./collect";
import {
  describeProcessesCommand,
  LIST_FDS_COMMAND,
  mergePorts,
  parseFdListing,
  parseProcessDetails,
  parseProcNetTcp,
  READ_SOCKETS_COMMAND,
  type PortEntry,
} from "./ports";

/** Discovery reads files in the container; it never takes seconds. */
const DISCOVERY_TIMEOUT_SECONDS = 15;

export class UnknownPortError extends Error {
  constructor(port: number) {
    super(`Nothing is listening on port ${port}`);
    this.name = "UnknownPortError";
  }
}

export async function listListeningPorts(
  manager: ContainerManager,
  identity: string,
): Promise<PortEntry[]> {
  const [socketsRead, fdsRead] = await Promise.all([
    collect(manager, identity, {
      command: READ_SOCKETS_COMMAND,
      timeoutSeconds: DISCOVERY_TIMEOUT_SECONDS,
    }),
    collect(manager, identity, {
      command: LIST_FDS_COMMAND,
      timeoutSeconds: DISCOVERY_TIMEOUT_SECONDS,
    }),
  ]);

  const sockets = parseProcNetTcp(socketsRead.stdout);
  if (sockets.length === 0) return [];

  const owners = parseFdListing(fdsRead.stdout);
  const pids = [...new Set([...owners.values()])];
  const described = await collect(manager, identity, {
    command: describeProcessesCommand(pids),
    timeoutSeconds: DISCOVERY_TIMEOUT_SECONDS,
  });

  return mergePorts({
    sockets,
    owners,
    details: parseProcessDetails(described.stdout),
  });
}

/** Whether the pid still exists, printed by the shell that signals it. */
const KILL_SCRIPT = (pid: number) =>
  `if [ -d /proc/${pid} ]; then kill -TERM ${pid} 2>/dev/null; echo killed; else echo missing; fi`;

/**
 * Stop the process listening on `port`.
 *
 * The listener is the process to stop: a dev server's parent (`npm`, `npm run`)
 * exits on its own once the child is gone, and killing a process group would
 * take the agent's shell with it.
 */
export async function killListeningPort(
  manager: ContainerManager,
  identity: string,
  port: number,
): Promise<{ port: number; pid: number; killed: boolean }> {
  const ports = await listListeningPorts(manager, identity);
  const entry = ports.find((candidate) => candidate.port === port);
  if (!entry) throw new UnknownPortError(port);
  if (entry.pid === null) {
    throw new UnknownPortError(port);
  }

  const result = await collect(manager, identity, {
    command: KILL_SCRIPT(entry.pid),
    timeoutSeconds: DISCOVERY_TIMEOUT_SECONDS,
  });

  return { port, pid: entry.pid, killed: result.stdout.trim() === "killed" };
}
