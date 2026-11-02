import { NextResponse } from "next/server";
import { getAccountPolicy } from "@/lib/auth/password-policy";

/**
 * GET /api/account-policy. The instance's password rules and 2FA requirement
 * Public endpoint. no auth required, so a form can answer before it submits
 */
export async function GET() {
  return NextResponse.json(await getAccountPolicy());
}
