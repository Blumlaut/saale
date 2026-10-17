"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { AlertCircle, ChevronRight, KeyRound, MessageCircle, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { isTotpCode } from "@/lib/auth/totp";
import { TELEGRAM_OIDC_PROVIDER_ID, telegramLoginError } from "@/lib/telegram/login";

const DASHBOARD_URL = "/dashboard/chat";

export interface TelegramLoginOptions {
  /** Whether this instance has Telegram sign-in configured and pointing at its bot. */
  enabled: boolean;
}

export interface LoginFormProps {
  telegram: TelegramLoginOptions;
  /** Whether someone with no account yet could create one here — the copy for a failed Telegram login depends on it. */
  signupsEnabled: boolean;
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-full px-4 py-2.5 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

function TwoFactorForm({ onVerified }: { onVerified: () => void }) {
  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const valid = mode === "totp" ? isTotpCode(code) : code.trim().length > 0;
    if (!valid) {
      setError(
        mode === "totp"
          ? "Enter the 6-digit code from your authenticator app"
          : "Enter a backup code",
      );
      return;
    }
    setLoading(true);
    setError("");
    const { error } =
      mode === "totp"
        ? await authClient.twoFactor.verifyTotp({
            code,
            trustDevice: trustDevice || undefined,
          })
        : await authClient.twoFactor.verifyBackupCode({ code: code.trim() });
    setLoading(false);
    if (error) {
      setError(error.message || "Invalid code");
      return;
    }
    onVerified();
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex items-center justify-center gap-2 text-sm">
        <ShieldCheck className="h-4 w-4" />
        Enter your verification code
      </div>

      {error && <ErrorBanner message={error} />}

      {mode === "totp" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="totp-code">Authenticator code</Label>
            <Input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="font-mono tracking-[0.5em]"
            />
          </div>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={trustDevice}
              onCheckedChange={(checked) => setTrustDevice(Boolean(checked))}
            />
            Remember this device for 30 days
          </label>
        </>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="backup-code">Backup code</Label>
          <Input
            id="backup-code"
            autoComplete="off"
            placeholder="xxxxx-xxxxx"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="font-mono"
          />
        </div>
      )}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Verifying..." : "Verify"}
      </Button>

      <p className="text-muted-foreground text-center text-sm">
        {mode === "totp" ? (
          <Button
            type="button"
            variant="link"
            className="gap-1 p-0"
            onClick={() => {
              setMode("backup");
              setCode("");
              setError("");
            }}
          >
            <KeyRound className="h-3.5 w-3.5" />
            Use a backup code instead
          </Button>
        ) : (
          <Button
            type="button"
            variant="link"
            className="p-0"
            onClick={() => {
              setMode("totp");
              setCode("");
              setError("");
            }}
          >
            Back to authenticator code
          </Button>
        )}
      </p>
    </form>
  );
}

function LoginFields({ telegram, signupsEnabled }: LoginFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // A Telegram login that fails comes back here with better-auth's error code.
  const [error, setError] = useState(
    () => telegramLoginError(searchParams?.get("error"), { signupsEnabled }) ?? "",
  );
  const [loading, setLoading] = useState(false);
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const { register, handleSubmit } = useForm<{ username: string; password: string }>();

  const finishSignIn = () => {
    router.push(DASHBOARD_URL);
    router.refresh();
  };

  const onTelegramSignIn = async () => {
    setTelegramLoading(true);
    setError("");

    // Implicit sign-up is off on this provider, so an unlinked Telegram account
    // comes back as an error instead of a new user; the register page is where
    // one can be created. Success hands the browser to Telegram, leaving only
    // a failure to answer here.
    const { error: signInError } = await authClient.signIn.social({
      provider: TELEGRAM_OIDC_PROVIDER_ID,
      callbackURL: DASHBOARD_URL,
      errorCallbackURL: "/auth/login",
    });

    setTelegramLoading(false);
    if (signInError) {
      setError(signInError.message || "Could not start Telegram sign-in");
    }
  };

  const onSubmit = handleSubmit(async (data: { username: string; password: string }) => {
    setLoading(true);
    setError("");

    // One field, two handles: usernames never contain `@`, so an address typed
    // here is an email — the fallback for accounts that have no username (or
    // for people who know the address better).
    const identifier = data.username.trim();
    const credentials = { password: data.password, callbackURL: DASHBOARD_URL };
    const { data: result, error } = identifier.includes("@")
      ? await authClient.signIn.email({ email: identifier, ...credentials })
      : await authClient.signIn.username({ username: identifier, ...credentials });

    setLoading(false);

    if (error) {
      setError(error.message || "Invalid username or password");
      return;
    }

    // When the user has 2FA enabled, the sign-in response is replaced with a
    // two-factor redirect payload (not part of the client's response type).
    const twoFactorRedirect = (result as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect;
    if (twoFactorRedirect) {
      setNeedsTwoFactor(true);
      return;
    }

    finishSignIn();
  });

  return (
    <GlassPanel className="animate-in fade-in slide-in-from-bottom-2 w-full max-w-md duration-200">
      <GlassPanelContent className="space-y-6">
        {/* Brand */}
        <div className="text-center">
          <div className="mb-4 flex items-center justify-center gap-2">
            <ChevronRight className="text-primary h-6 w-6" />
            <span className="text-2xl font-bold tracking-tight">Saale</span>
          </div>
          <p className="text-muted-foreground text-sm">
            {needsTwoFactor ? "Two-factor authentication required" : "Sign in to your account"}
          </p>
        </div>

        {needsTwoFactor ? (
          <TwoFactorForm onVerified={finishSignIn} />
        ) : (
          <>
            {/* Form */}
            <form onSubmit={onSubmit} className="space-y-4">
              {error && <ErrorBanner message={error} />}

              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                {/* `autoComplete="username"` and the `username` field name are what
                    password managers key on to offer the stored credential. */}
                <Input
                  id="username"
                  placeholder="username or email"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  {...register("username")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  {...register("password")}
                />
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </form>

            {/* Telegram sign-in, when this instance has it set up */}
            {telegram.enabled && (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-muted-foreground text-xs">or</span>
                  <Separator className="flex-1" />
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={telegramLoading}
                  onClick={onTelegramSignIn}
                >
                  <MessageCircle />
                  {telegramLoading ? "Opening Telegram..." : "Continue with Telegram"}
                </Button>
              </div>
            )}

            {/* Sign up link */}
            <p className="text-muted-foreground text-center text-sm">
              Don&apos;t have an account?{" "}
              <Button variant="link" className="p-0" onClick={() => router.push("/auth/register")}>
                Sign up
              </Button>
            </p>
          </>
        )}
      </GlassPanelContent>
    </GlassPanel>
  );
}

/**
 * The login page's form.
 *
 * Reads its error from the query string (`useSearchParams`), which is why the
 * page renders it inside a Suspense boundary.
 */
export function LoginForm({ telegram, signupsEnabled }: LoginFormProps) {
  return (
    <Suspense fallback={null}>
      <LoginFields telegram={telegram} signupsEnabled={signupsEnabled} />
    </Suspense>
  );
}
