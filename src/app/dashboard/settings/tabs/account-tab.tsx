"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Shield, Loader2, AlertCircle, CheckCircle } from "lucide-react";
import { authClient } from "@/lib/auth-client";

interface FormData {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export function AccountTab() {
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormData>();

  const newPassword = watch("newPassword");

  // Auto-clear status
  useEffect(() => {
    if (status !== "idle") {
      const timer = setTimeout(() => {
        setStatus("idle");
        setErrorMessage("");
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  const onSubmit = handleSubmit(async (data: FormData) => {
    setLoading(true);
    setStatus("idle");
    setErrorMessage("");

    const { error } = await authClient.changePassword({
      currentPassword: data.currentPassword,
      newPassword: data.newPassword,
    });

    setLoading(false);

    if (error) {
      setStatus("error");
      setErrorMessage(error.message || "Failed to update password");
      return;
    }

    setStatus("success");
    reset();
  });

  return (
    <GlassPanel>
      <GlassPanelContent className="space-y-6">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-medium">
            <Shield className="h-5 w-5" />
            Account
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage your account security settings
          </p>
        </div>

        {/* Password section */}
        <div className="liquid-glass-inner space-y-5 rounded-2xl border-0 p-5">
          <div>
            <h4 className="text-sm font-medium">Change Password</h4>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Update your password to keep your account secure
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            {status === "error" && (
              <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-full px-4 py-2.5 text-sm">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {errorMessage}
              </div>
            )}

            {status === "success" && (
              <div className="flex items-center gap-2 rounded-full bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle className="h-4 w-4 shrink-0" />
                Password updated successfully
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current Password</Label>
              <Input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                {...register("currentPassword", {
                  required: "Current password is required",
                })}
              />
              {errors.currentPassword && (
                <p className="text-destructive text-xs">{errors.currentPassword.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="newPassword">New Password</Label>
              <Input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                {...register("newPassword", {
                  required: "New password is required",
                  minLength: {
                    value: 8,
                    message: "Password must be at least 8 characters",
                  },
                  maxLength: {
                    value: 128,
                    message: "Password must be less than 128 characters",
                  },
                })}
              />
              {errors.newPassword && (
                <p className="text-destructive text-xs">{errors.newPassword.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm New Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                {...register("confirmPassword", {
                  required: "Please confirm your new password",
                  validate: (value) => value === newPassword || "Passwords do not match",
                })}
              />
              {errors.confirmPassword && (
                <p className="text-destructive text-xs">{errors.confirmPassword.message}</p>
              )}
            </div>

            <div className="flex justify-end pt-1">
              <Button type="submit" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {loading ? "Updating..." : "Update Password"}
              </Button>
            </div>
          </form>
        </div>
      </GlassPanelContent>
    </GlassPanel>
  );
}
