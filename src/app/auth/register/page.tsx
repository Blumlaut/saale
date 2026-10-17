import { getTelegramLoginStatus } from "@/lib/telegram/oidc";
import { RegisterForm } from "./register-form";

/**
 * The register page's server half: whether Telegram may create an account is
 * the instance's to decide, so the button is known before anything renders.
 */
export default async function RegisterPage() {
  const telegram = await getTelegramLoginStatus();

  return <RegisterForm telegram={{ enabled: telegram.enabled }} />;
}
