import { areSignupsEnabled } from "@/lib/auth/signups";
import { getTelegramLoginStatus } from "@/lib/telegram/oidc";
import { LoginForm } from "./login-form";

/**
 * The login page's server half: it decides whether Telegram sign-in is on offer
 * before anything renders, so the button never appears and then disappears.
 */
export default async function LoginPage() {
  const [telegram, signupsEnabled] = await Promise.all([
    getTelegramLoginStatus(),
    areSignupsEnabled(),
  ]);

  return <LoginForm telegram={{ enabled: telegram.enabled }} signupsEnabled={signupsEnabled} />;
}
