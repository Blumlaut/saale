"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { AlertCircle, CheckCircle, ChevronRight } from "lucide-react";
import { ErrorBanner, NoteBanner } from "@/components/auth/form-banner";
import { authClient } from "@/lib/auth-client";
import { passwordProblem, passwordRules } from "@/lib/auth/password";

const LOGIN_PATH = "/auth/login";
const FORGOT_PATH = "/auth/forgot-password";

export interface ResetPasswordFormProps {
  /** The instance's own minimum, which the request checks again on its way in. */
  minPasswordLength: number;
}

interface ResetFields {
  password: string;
  confirmPassword: string;
}

function Brand() {
  return (
    <div className="text-center">
      <div className="mb-4 flex items-center justify-center gap-2">
        <ChevronRight className="text-primary h-6 w-6" />
        <span className="text-2xl font-bold tracking-tight">Saale</span>
      </div>
      <p className="text-muted-foreground text-sm">Choose a new password</p>
    </div>
  );
}

function ResetFields({ minPasswordLength }: ResetPasswordFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [token] = useState(() => searchParams?.get("token") ?? "");
  // The link lands here twice: once with a token, and with `error=INVALID_TOKEN`
  // when the token expired or was already used.
  const [expired] = useState(() => !token || searchParams?.get("error") === "INVALID_TOKEN");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const { register, handleSubmit, watch } = useForm<ResetFields>();

  const typed = watch("password");

  const onSubmit = handleSubmit(async ({ password, confirmPassword }) => {
    const problem = passwordProblem(password, minPasswordLength);
    if (problem) {
      setError(`The password needs ${problem.toLowerCase()}.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("The two passwords do not match.");
      return;
    }

    setLoading(true);
    setError("");

    const { error: resetError } = await authClient.resetPassword({
      newPassword: password,
      token,
    });

    setLoading(false);
    if (resetError) {
      setError(resetError.message || "Could not set the new password");
      return;
    }

    setDone(true);
    setTimeout(() => router.push(LOGIN_PATH), 1500);
  });

  return (
    <GlassPanel className="animate-in fade-in slide-in-from-bottom-2 w-full max-w-md duration-200">
      <GlassPanelContent className="space-y-6">
        <Brand />

        {expired ? (
          <>
            <NoteBanner icon={<AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}>
              This link has expired or has already been used. Ask for a new one and it will work for
              an hour.
            </NoteBanner>
            <Button className="w-full" onClick={() => router.push(FORGOT_PATH)}>
              Ask for a new link
            </Button>
          </>
        ) : done ? (
          <NoteBanner icon={<CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />}>
            Your password is changed. Take your pick of the ways in on the sign-in page.
          </NoteBanner>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            {error && <ErrorBanner message={error} />}

            <div className="space-y-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                {...register("password")}
              />
              <p className="text-muted-foreground text-xs">{passwordRules(minPasswordLength)}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Repeat it</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                {...register("confirmPassword")}
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading || typed === ""}>
              {loading ? "Saving..." : "Set the password"}
            </Button>
          </form>
        )}
      </GlassPanelContent>
    </GlassPanel>
  );
}

/** The page's form. Reads the token from the query string, hence the Suspense boundary. */
export function ResetPasswordForm({ minPasswordLength }: ResetPasswordFormProps) {
  return (
    <Suspense fallback={null}>
      <ResetFields minPasswordLength={minPasswordLength} />
    </Suspense>
  );
}
