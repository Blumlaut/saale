"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { TwoFactorDialog } from "@/components/auth/two-factor-dialog";
import { authClient } from "@/lib/auth-client";
import { KeyRound, LogOut, ShieldAlert } from "lucide-react";

/** The requirement an account without two-factor is held on. */
export function TwoFactorRequired() {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const leaveWhenEnrolled = async () => {
    const { data, error } = await authClient.getSession();
    if (error) {
      console.error("Failed to read the two-factor state:", error);
      return;
    }
    if (data?.user?.twoFactorEnabled) router.replace("/dashboard/chat");
  };

  const signOut = async () => {
    setSigningOut(true);
    const { error } = await authClient.signOut();
    if (error) {
      console.error("Failed to sign out:", error);
      setSigningOut(false);
      return;
    }
    router.replace("/auth/login");
  };

  return (
    <GlassPanel className="w-full max-w-md">
      <GlassPanelContent className="space-y-4">
        <div className="flex items-center gap-2">
          <ShieldAlert className="text-primary h-5 w-5 shrink-0" />
          <h1 className="text-lg font-semibold">Two-factor is now required</h1>
        </div>

        <p className="text-muted-foreground text-sm">
          An admin turned on two-factor sign-in for this instance. Add an authenticator app to your
          account to keep using Saale.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialogOpen(true)}>
            <KeyRound className="h-4 w-4" />
            Set up two-factor
          </Button>
          <Button variant="ghost" disabled={signingOut} onClick={() => void signOut()}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </GlassPanelContent>

      <TwoFactorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode="enable"
        onStateChange={() => void leaveWhenEnrolled()}
      />
    </GlassPanel>
  );
}
