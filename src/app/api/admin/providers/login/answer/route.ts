import { requireAdmin } from "@/app/api/admin/settings/auth";
import { answerLoginResponse } from "@/lib/providers/login-api";

/** POST /api/admin/providers/login/answer — answer a global sign-in's step. */
export async function POST(request: Request) {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;
  return answerLoginResponse({ kind: "global" }, request);
}
