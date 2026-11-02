import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth";
import { fetchVoiceModels } from "@/lib/voice/models";

/** GET /api/admin/voice/models. The models the transcription server offers. */
export async function GET() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  try {
    return NextResponse.json({ models: await fetchVoiceModels() });
  } catch (err) {
    // No server, or one that is not up yet: the page says so and keeps the
    // model it has.
    console.error("Failed to read the transcription server's models:", err);
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `The transcription server did not report its models: ${reason}` },
      { status: 502 },
    );
  }
}
