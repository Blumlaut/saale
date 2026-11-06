import { getAccountPolicy } from "@/lib/auth/password-policy";
import { ResetPasswordForm } from "./reset-password-form";

/** The new password is measured against the instance's own minimum, as the form is typed. */
export default async function ResetPasswordPage() {
  const policy = await getAccountPolicy();

  return <ResetPasswordForm minPasswordLength={policy.minPasswordLength} />;
}
