import { requireSession } from "@/lib/auth";
import {
  cancelLoginResponse,
  loginStateResponse,
  startLoginResponse,
} from "@/lib/providers/login-api";

/**
 * Sign-in to a provider, using Pi's own auth flow.
 *
 * POST   — start one; the body names the provider and the auth type
 * GET    — poll it (`?id=`)
 * DELETE — cancel it (`?id=`)
 */

export async function POST(request: Request) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  return startLoginResponse({ kind: "user", userId: authResult.user.id }, request);
}

export async function GET(request: Request) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  return loginStateResponse({ kind: "user", userId: authResult.user.id }, request);
}

export async function DELETE(request: Request) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  return cancelLoginResponse({ kind: "user", userId: authResult.user.id }, request);
}
