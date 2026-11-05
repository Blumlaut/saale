import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  clearInstanceMail,
  instanceMailStatus,
  instanceMailPatchSchema,
  saveInstanceMail,
  sendInstanceMailTest,
} from "@/lib/email/instance-mail";
import { readJsonBody } from "@/lib/api-body";

/**
 * The instance's outgoing mail relay.
 *
 * Admin-scoped, and the password is never echoed back: a read reports whether
 * one is stored, which is what the form needs to show.
 */

export async function GET() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ mail: await instanceMailStatus() });
}

export async function PATCH(request: NextRequest) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const body = await readJsonBody(request, instanceMailPatchSchema);
  if (!body.ok) return body.response;

  try {
    const mail = await saveInstanceMail(body.data, authResult.user.id);
    return NextResponse.json({ mail });
  } catch (err) {
    console.error("Failed to save the instance mail settings:", err);
    return NextResponse.json({ error: "Could not save the mail settings" }, { status: 400 });
  }
}

export async function DELETE() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  await clearInstanceMail();
  return NextResponse.json({ mail: await instanceMailStatus() });
}

const testSchema = z.object({ to: z.email() });

/** Send a test message to an address, so an admin can prove the relay works. */
export async function POST(request: NextRequest) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const body = await readJsonBody(request, testSchema);
  if (!body.ok) return body.response;

  const result = await sendInstanceMailTest(body.data.to);
  return NextResponse.json(result, { status: result.sent ? 200 : 400 });
}
