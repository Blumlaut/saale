"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { AlertCircle, CheckCircle, ChevronRight, Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { fetchJson } from "@/lib/http";
import { USERNAME_RULES, isValidUsername, normalizeUsername } from "@/lib/auth/username";

interface RegisterForm {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [signupsEnabled, setSignupsEnabled] = useState<boolean | null>(null);
  const { register, handleSubmit, watch } = useForm<RegisterForm>();

  const password = watch("password");
  const usernameValue = watch("username");
  const usernameInvalid = Boolean(usernameValue) && !isValidUsername(usernameValue);

  // Check if signups are enabled
  useEffect(() => {
    fetchJson<{ enabled: boolean }>("/api/signups/enabled")
      .then((data) => setSignupsEnabled(data.enabled))
      .catch(() => setSignupsEnabled(true)); // default to enabled
  }, []);

  const onSubmit = handleSubmit(async (data) => {
    setLoading(true);
    setError("");
    setSuccess("");

    // The handle is the whole identity now — no separate full name. Store the
    // typed form as the display name and the normalized one as the handle.
    const username = normalizeUsername(data.username);
    if (!isValidUsername(username)) {
      setError(`That username does not fit: ${USERNAME_RULES}.`);
      setLoading(false);
      return;
    }

    if (data.password !== data.confirmPassword) {
      setError("Passwords do not match");
      setLoading(false);
      return;
    }

    const { error } = await authClient.signUp.email({
      name: data.username.trim(),
      username,
      email: data.email,
      password: data.password,
      callbackURL: "/dashboard/chat",
    });

    setLoading(false);

    if (error) {
      setError(error.message || "Registration failed");
      return;
    }

    setSuccess("Account created! Redirecting...");
    setTimeout(() => router.push("/dashboard/chat"), 1500);
  });

  // Loading while checking signup status
  if (signupsEnabled === null) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  // Signups disabled
  if (!signupsEnabled) {
    return (
      <GlassPanel className="animate-in fade-in slide-in-from-bottom-2 w-full max-w-md duration-200">
        <GlassPanelContent className="space-y-6">
          <div className="text-center">
            <div className="mb-4 flex items-center justify-center gap-2">
              <ChevronRight className="text-primary h-6 w-6" />
              <span className="text-2xl font-bold tracking-tight">Saale</span>
            </div>
            <p className="text-muted-foreground text-sm">Registration is currently disabled</p>
            <p className="text-muted-foreground mt-2 text-xs">
              Please check back later or contact an administrator
            </p>
          </div>
          <Button variant="secondary" className="w-full" onClick={() => router.push("/auth/login")}>
            Sign in instead
          </Button>
        </GlassPanelContent>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel className="animate-in fade-in slide-in-from-bottom-2 w-full max-w-md duration-200">
      <GlassPanelContent className="space-y-6">
        {/* Brand */}
        <div className="text-center">
          <div className="mb-4 flex items-center justify-center gap-2">
            <ChevronRight className="text-primary h-6 w-6" />
            <span className="text-2xl font-bold tracking-tight">Saale</span>
          </div>
          <p className="text-muted-foreground text-sm">Create your account</p>
        </div>

        {/* Form */}
        <form onSubmit={onSubmit} className="space-y-4">
          {error && (
            <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-full px-4 py-2.5 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 rounded-full bg-green-500/10 px-4 py-2.5 text-sm text-green-600 dark:text-green-400">
              <CheckCircle className="h-4 w-4 shrink-0" />
              {success}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="ada.lovelace"
              aria-invalid={usernameInvalid}
              {...register("username")}
            />
            <p
              className={
                usernameInvalid ? "text-destructive text-xs" : "text-muted-foreground text-xs"
              }
            >
              {USERNAME_RULES}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              {...register("email")}
            />
          </div>

          {/* `new-password` on both fields so managers offer to generate a password
              here instead of filling the stored one. */}
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              {...register("password")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              {...register("confirmPassword")}
            />
            {watch("confirmPassword") && watch("confirmPassword") !== password && (
              <p className="text-destructive text-xs">Passwords do not match</p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Creating account..." : "Create account"}
          </Button>
        </form>

        {/* Sign in link */}
        <p className="text-muted-foreground text-center text-sm">
          Already have an account?{" "}
          <Button variant="link" className="p-0" onClick={() => router.push("/auth/login")}>
            Sign in
          </Button>
        </p>
      </GlassPanelContent>
    </GlassPanel>
  );
}
