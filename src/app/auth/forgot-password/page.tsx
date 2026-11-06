import { instanceMailStatus } from "@/lib/email/instance-mail";
import { ForgotPasswordForm } from "./forgot-password-form";

/**
 * A reset link can only leave an instance that has a relay, so the page knows
 * that before it renders and says so rather than promising a mail that will
 * never arrive.
 */
export default async function ForgotPasswordPage() {
  const mail = await instanceMailStatus();

  return <ForgotPasswordForm mailConfigured={mail.configured} />;
}
