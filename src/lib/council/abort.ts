/**
 * Stopping a run that is already in flight.
 *
 * A run's loop lives in the web process and holds model calls open for minutes,
 * so "stop" cannot be a database write the loop notices at leisure — it has to
 * reach the loop wherever it is running. A Redis flag does that regardless of
 * which replica handled the route or whether the run was dispatched by the
 * watchdog, and it is checked both at every turn boundary and by the in-flight
 * turn's deadline race.
 *
 * Keyed by run id (a cuid, so unguessable) and given a TTL: a flag whose run is
 * long gone would otherwise sit in Redis forever, and the run id is what makes
 * the flag unambiguous.
 */

import { getRedis } from "@/lib/redis";

/** How long an abort request outlives its run. */
const ABORT_TTL_SECONDS = 24 * 60 * 60;

const abortKey = (runId: string) => `council:abort:${runId}`;

/** Ask a running council run to stop. */
export async function requestCouncilAbort(runId: string): Promise<void> {
  const redis = getRedis();
  await redis.set(abortKey(runId), "1", "EX", ABORT_TTL_SECONDS);
}

export async function isCouncilAbortRequested(runId: string): Promise<boolean> {
  const redis = getRedis();
  const value = await redis.get(abortKey(runId));
  return value !== null;
}

/** Clear the request once the run has stopped, so a retry starts clean. */
export async function clearCouncilAbort(runId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(abortKey(runId));
}
