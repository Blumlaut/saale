/**
 * The commands currently running, by the id the API hands out.
 *
 * A stop request arrives on a second connection, so the running command has to
 * be findable by id alone. In memory is enough: a restart of the service ends
 * every stream it was serving.
 */

import type { ContainerHandle, ExecHandle } from "./containers";

export interface RunningExec {
  identity: string;
  /** Where the command's process group id was written inside the container. */
  pgidFile: string;
  container: ContainerHandle;
  exec: ExecHandle;
  /** Set once the exec has finished on its own or been signalled. */
  settled: boolean;
}

export interface ExecRegistry {
  add(id: string, entry: RunningExec): void;
  get(id: string): RunningExec | undefined;
  delete(id: string): void;
  /** Ids currently running for an identity (for teardown). */
  idsFor(identity: string): string[];
  size(): number;
}

export function createExecRegistry(): ExecRegistry {
  const entries = new Map<string, RunningExec>();

  return {
    add(id, entry) {
      entries.set(id, entry);
    },
    get(id) {
      return entries.get(id);
    },
    delete(id) {
      entries.delete(id);
    },
    idsFor(identity) {
      return [...entries.entries()]
        .filter(([, entry]) => entry.identity === identity)
        .map(([id]) => id);
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * A command that is not there any more.
 *
 * The API answers 404 for it: a stop for a command that already finished is an
 * outcome, not a failure the caller has to handle differently.
 */
export class UnknownExecError extends Error {
  constructor(id: string) {
    super(`No running command ${id}`);
    this.name = "UnknownExecError";
  }
}
