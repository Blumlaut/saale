import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sweepWorktrees } from "@/lib/coder/sweep";

/**
 * POST /api/coder/sweep
 *
 * Internal endpoint the worker calls daily. It marks worktree rows whose
 * checkout is gone, prunes git's metadata and logs directories nothing claims.
 * It never deletes a directory.
 */
export async function POST(request: NextRequest) {
  const workerApiKey = process.env.WORKER_API_KEY ?? "";
  const key = request.headers.get("x-worker-key");
  if (!workerApiKey || key !== workerApiKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sweepWorktrees();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[api/coder/sweep] Worktree sweep failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
