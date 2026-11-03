import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sweepOrphanProcesses } from "@/lib/coder/process-sweep";
import { isConfigured, listContainers } from "@/lib/sandbox/client";

/** What the sweep reports when it had nothing to look at. */
const idle = { stopped: [], live: 0 };

/** The workspaces whose container is up right now. */
async function runningIdentities(): Promise<Set<string>> {
  const containers = await listContainers();
  return new Set(
    containers.filter((container) => container.state === "running").map(({ identity }) => identity),
  );
}

/**
 * POST /api/coder/sweep
 *
 * Internal endpoint the worker calls daily. It stops what a deleted chat left
 * running, in the workspaces whose container is up. A stopped container holds
 * no processes, so it is left alone rather than started for a look.
 */
export async function POST(request: NextRequest) {
  const workerApiKey = process.env.WORKER_API_KEY ?? "";
  const key = request.headers.get("x-worker-key");
  if (!workerApiKey || key !== workerApiKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (!isConfigured()) return NextResponse.json({ success: true, processes: idle });
    const processes = await sweepOrphanProcesses(await runningIdentities());
    return NextResponse.json({ success: true, processes });
  } catch (err) {
    console.error("[api/coder/sweep] Coder sweep failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
