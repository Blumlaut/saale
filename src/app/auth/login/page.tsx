"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { AlertCircle, ChevronRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { register, handleSubmit } = useForm<{ email: string; password: string }>();

  const onError = searchParams?.get("error");
  if (onError) {
    setError(onError);
  }

  const onSubmit = handleSubmit(async (data: { email: string; password: string }) => {
    setLoading(true);
    setError("");

    const { error } = await authClient.signIn.email({
      email: data.email,
      password: data.password,
      callbackURL: "/dashboard/chat",
    });

    setLoading(false);

    if (error) {
      setError(error.message || "Invalid email or password");
      return;
    }

    router.push("/dashboard/chat");
    router.refresh();
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
          <p className="text-muted-foreground text-sm">Sign in to your account</p>
        </div>

        {/* Form */}
        <form onSubmit={onSubmit} className="space-y-4">
          {error && (
            <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-full px-4 py-2.5 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

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

        {/* Sign up link */}
        <p className="text-muted-foreground text-center text-sm">
          Don&apos;t have an account?{" "}
          <Button variant="link" className="p-0" onClick={() => router.push("/auth/register")}>
            Sign up
          </Button>
        </p>
      </GlassPanelContent>
    </GlassPanel>
  );
}
