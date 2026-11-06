"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { AlertCircle, CheckCircle, ChevronRight } from "lucide-react";
import { ErrorBanner, NoteBanner } from "@/components/auth/form-banner";
import { authClient } from "@/lib/auth-client";

/** Where the link in the mail lands. */
const RESET_PATH = "/auth/reset-password";

export interface ForgotPasswordFormProps {
  /** Whether this instance has a relay; without one there is no link to send. */
  mailConfigured: boolean;
}

/**
 * Asks the instance for a reset link.
 *
 * The answer is the same whether or not the address has an account, so the
 * page cannot be used to find out who is registered here.
 */
export function ForgotPasswordForm({ mailConfigured }: ForgotPasswordFormProps) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const { register, handleSubmit } = useForm<{ email: string }>();

  const onSubmit = handleSubmit(async ({ email }) => {
    setLoading(true);
    setError("");

    const { error: requestError } = await authClient.requestPasswordReset({
      email: email.trim(),
      redirectTo: RESET_PATH,
    });

    setLoading(false);
    if (requestError) {
      setError(requestError.message || "Could not ask for a reset link");
      return;
    }

    setSent(true);
  });

  return (
    <GlassPanel className="animate-in fade-in slide-in-from-bottom-2 w-full max-w-md duration-200">
      <GlassPanelContent className="space-y-6">
        <div className="text-center">
          <div className="mb-4 flex items-center justify-center gap-2">
            <ChevronRight className="text-primary h-6 w-6" />
            <span className="text-2xl font-bold tracking-tight">Saale</span>
          </div>
          <p className="text-muted-foreground text-sm">Reset your password</p>
        </div>

        {!mailConfigured ? (
          <NoteBanner icon={<AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}>
            This instance has no mail server set up, so it cannot send a reset link. Ask an admin to
            set a new password for you.
          </NoteBanner>
        ) : sent ? (
          <NoteBanner icon={<CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />}>
            If that address has an account here, a reset link is on its way. The link is good for
            one hour.
          </NoteBanner>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            {error && <ErrorBanner message={error} />}

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="you@company.com"
                {...register("email")}
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Sending..." : "Send the link"}
            </Button>
          </form>
        )}

        <p className="text-muted-foreground text-center text-sm">
          <Button
            type="button"
            variant="link"
            className="p-0"
            onClick={() => router.push("/auth/login")}
          >
            Back to sign in
          </Button>
        </p>
      </GlassPanelContent>
    </GlassPanel>
  );
}
