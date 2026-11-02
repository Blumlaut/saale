import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { loginPath } from "@/lib/auth/redirect";
import { isTwoFactorRequired } from "@/lib/auth/two-factor-policy";
import { TwoFactorRequired } from "./two-factor-required";

export const dynamic = "force-dynamic";

/**
 * Where an account lands while the instance requires two-factor and it has
 * none: the requirement, and the one action that clears it.
 */
export default async function TwoFactorRequiredPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(loginPath("/dashboard/chat"));

  // Nothing is owed once it is set up, or once an admin turned the rule off.
  if (session.user.twoFactorEnabled || !(await isTwoFactorRequired())) {
    redirect("/dashboard/chat");
  }

  return <TwoFactorRequired />;
}
