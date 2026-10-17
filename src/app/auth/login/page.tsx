import { getTelegramLoginStatus } from "@/lib/telegram/oidc";
import { LoginForm } from "./login-form";

/**
 * The login page's server half: it decides whether Telegram sign-in is on offer
 * before anything renders, so the button never appears and then disappears.
 */
export default async function LoginPage() {
  const telegram = await getTelegramLoginStatus();

  return <LoginForm telegram={{ enabled: telegram.enabled }} />;
}
