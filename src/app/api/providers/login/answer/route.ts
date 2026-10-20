import { requireSession } from "@/lib/auth";
import { answerLoginResponse } from "@/lib/providers/login-api";

/** POST /api/providers/login/answer. answer the step a sign-in waits on. */
export async function POST(request: Request) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  return answerLoginResponse({ kind: "user", userId: authResult.user.id }, request);
}
