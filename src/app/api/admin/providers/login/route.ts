import { requireAdmin } from "@/app/api/admin/settings/auth";
import {
  cancelLoginResponse,
  loginStateResponse,
  startLoginResponse,
} from "@/lib/providers/login-api";

/**
 * Sign-in to a provider for the *global* configuration, using Pi's own auth
 * flow. Same protocol as the user route, restricted to admins, writing the
 * credential every user inherits.
 */

export async function POST(request: Request) {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;
  return startLoginResponse({ kind: "global" }, request);
}

export async function GET(request: Request) {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;
  return loginStateResponse({ kind: "global" }, request);
}

export async function DELETE(request: Request) {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;
  return cancelLoginResponse({ kind: "global" }, request);
}
