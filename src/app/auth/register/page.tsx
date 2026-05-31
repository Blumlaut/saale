"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, CheckCircle } from "lucide-react";
import { authClient } from "@/lib/auth-client";

interface RegisterForm {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const { register, handleSubmit, watch } = useForm<RegisterForm>();

  const password = watch("password");

  const onSubmit = handleSubmit(async (data) => {
    setLoading(true);
    setError("");
    setSuccess("");

    if (data.password !== data.confirmPassword) {
      setError("Passwords do not match");
      setLoading(false);
      return;
    }

    const { error } = await authClient.signUp.email({
      name: data.name,
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

  return (
    <Card className="mx-4 w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold tracking-tight">Saale</CardTitle>
        <CardDescription>Create your account</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {error && (
            <div className="bg-destructive/15 text-destructive flex items-center gap-2 rounded-md px-3 py-2 text-sm">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 rounded-md bg-green-500/15 px-3 py-2 text-sm text-green-600 dark:text-green-400">
              <CheckCircle className="h-4 w-4" />
              {success}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" placeholder="Your name" {...register("name")} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="you@example.com" {...register("email")} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" {...register("password")} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm Password</Label>
            <Input id="confirmPassword" type="password" {...register("confirmPassword")} />
            {watch("confirmPassword") && watch("confirmPassword") !== password && (
              <p className="text-destructive text-xs">Passwords do not match</p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Creating account..." : "Create account"}
          </Button>
        </form>

        <div className="text-muted-foreground mt-4 text-center text-sm">
          Already have an account?{" "}
          <Button variant="link" className="p-0" onClick={() => router.push("/auth/login")}>
            Sign in
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
