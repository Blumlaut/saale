import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { redeemPairCode } from "@/lib/devices/pairing";
import { isRateLimited } from "@/lib/redis";

/**
 * POST /api/devices/pair. trade a pairing code for a token.
 *
 * The only unauthenticated device endpoint: the agent has no credential yet.
 * The code is the credential, and it is single-use, so this is rate limited per
 * address as well.
 */
export async function POST(request: NextRequest) {
  const address =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";
  if (await isRateLimited(`device-pair:${address}`)) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const code = typeof body.code === "string" ? body.code : "";
  if (!code.trim()) {
    return NextResponse.json({ error: "A pairing code is required" }, { status: 400 });
  }

  const result = await redeemPairCode({
    code,
    name: typeof body.name === "string" ? body.name : "computer",
    platform: typeof body.platform === "string" ? body.platform : "linux",
    session: typeof body.session === "string" ? body.session : "unknown",
    capabilities: body.capabilities,
    agentVersion: typeof body.agentVersion === "string" ? body.agentVersion : "",
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          result.reason === "expired"
            ? "That code expired. Get a new one in Saale."
            : "That code is not valid.",
      },
      { status: 400 },
    );
  }

  return NextResponse.json({ deviceId: result.deviceId, name: result.name, token: result.token });
}
