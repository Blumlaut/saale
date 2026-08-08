import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { triggerAgentRun } from "@/lib/agent-jobs/run";
import { unscheduleAgentDefinition } from "@/lib/queue";

/**
 * POST /api/agent-jobs/execute
 * Internal endpoint called by the BullMQ worker for scheduled agent definitions.
 * Authenticated via x-worker-key header.
 *
 * The definition is loaded fresh from the database so edits (prompt, output
 * channel, etc.) take effect on the next scheduled run. If the definition was
 * deleted or disabled since scheduling, the repeatable scheduler is removed
 * and the job is skipped instead of retrying forever.
 */
export async function POST(request: NextRequest) {
  // Read at call time so tests can set the env var and it never goes stale
  const WORKER_API_KEY = process.env.WORKER_API_KEY ?? "";
  const key = request.headers.get("x-worker-key");

  if (key !== WORKER_API_KEY || !WORKER_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { definitionId } = body as { definitionId?: string };

  if (!definitionId) {
    return NextResponse.json({ error: "definitionId is required" }, { status: 400 });
  }

  const definition = await prisma.agentDefinition.findUnique({
    where: { id: definitionId },
    select: { id: true, enabled: true, userId: true },
  });

  if (!definition || !definition.enabled) {
    // Definition deleted or disabled — stop the repeatable job so it doesn't
    // keep firing, then skip silently (matching QueueTask deleted-job handling).
    if (!definition) {
      console.warn(
        `[api/agent-jobs/execute] Definition ${definitionId} not found, removing scheduler.`,
      );
    } else {
      console.warn(
        `[api/agent-jobs/execute] Definition ${definitionId} is disabled, removing scheduler.`,
      );
    }
    await unscheduleAgentDefinition(definitionId);
    return NextResponse.json({ success: true, skipped: true });
  }

  try {
    const run = await triggerAgentRun({
      definitionId,
      userId: definition.userId,
    });

    return NextResponse.json({ success: true, runId: run.id });
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[api/agent-jobs/execute] Run for definition ${definitionId} failed:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
