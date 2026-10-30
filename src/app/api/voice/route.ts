import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { voiceConfig } from "@/lib/voice/config";

/** GET /api/voice. Whether this deployment transcribes speech at all. */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ enabled: voiceConfig() !== null });
}
