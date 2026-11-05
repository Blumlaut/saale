import { areSignupsEnabled } from "@/lib/auth/signups";
import { getSsoStatus } from "@/lib/auth/sso";
import { SSO_DEFAULT_NAME } from "@/lib/auth/sso-config";
import { getTelegramLoginStatus } from "@/lib/telegram/oidc";
import { LoginForm } from "./login-form";

/**
 * The login page's server half: it decides which sign-in methods are on offer
 * before anything renders, so a button never appears and then disappears.
 */
export default async function LoginPage() {
  const [telegram, sso, signupsEnabled] = await Promise.all([
    getTelegramLoginStatus(),
    getSsoStatus(),
    areSignupsEnabled(),
  ]);

  return (
    <LoginForm
      telegram={{ enabled: telegram.enabled }}
      sso={{ enabled: sso.configured, name: sso.name || SSO_DEFAULT_NAME }}
      signupsEnabled={signupsEnabled}
    />
  );
}
