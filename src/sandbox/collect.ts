/**
 * A command whose output the service reads rather than streams.
 *
 * `ContainerManager.run` reports chunks as they arrive, which is what a caller
 * streaming to a browser wants. Discovery wants the finished text, so it drains
 * the chunks here and throws when the command fails: half a `/proc` listing is a
 * wrong port list, not a short one.
 */

import type { ContainerManager, SandboxExecRequest } from "./containers";

export interface CollectedOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Largest output kept. A `/proc` listing is kilobytes; this is a guard. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export async function collect(
  manager: ContainerManager,
  identity: string,
  request: SandboxExecRequest,
): Promise<CollectedOutput> {
  const chunks: Buffer[] = [];
  let size = 0;
  let stderr = "";

  const session = await manager.run(identity, request, (chunk) => {
    if (chunk.stream === "stderr") {
      if (stderr.length < 4096) stderr += chunk.data.toString("utf8");
      return;
    }
    if (size >= MAX_OUTPUT_BYTES) return;
    size += chunk.data.length;
    chunks.push(chunk.data);
  });

  const result = await session.result;
  return { stdout: Buffer.concat(chunks).toString("utf8"), stderr, exitCode: result.exitCode };
}
