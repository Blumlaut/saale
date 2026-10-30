"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, CheckCircle, Copy, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { isTotpCode, parseTotpSecret } from "@/lib/auth/totp";

export type TwoFactorDialogMode = "enable" | "disable" | "backup-codes";

type EnableStep = "password" | "verify" | "done";

interface EnableData {
  totpURI: string;
  backupCodes: string[];
}

const TITLES: Record<TwoFactorDialogMode, { title: string; description: string }> = {
  enable: {
    title: "Set up two-factor",
    description: "Add an authenticator app to protect your account",
  },
  disable: {
    title: "Turn off two-factor",
    description: "Your account will no longer require a second factor",
  },
  "backup-codes": {
    title: "Backup codes",
    description: "Generate a new set of one-time backup codes",
  },
};

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-full px-4 py-2.5 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

function BackupCodesList({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy backup codes:", err);
    }
  };

  return (
    <div className="liquid-glass-inner space-y-2 rounded-2xl p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          Each code works once if you lose access to your authenticator.
        </p>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={copyAll}>
          {copied ? <CheckCircle className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy all"}
        </Button>
      </div>
      <ul className="grid grid-cols-2 gap-1.5">
        {codes.map((code) => (
          <li key={code} className="text-foreground rounded-md border px-2 py-1 text-xs break-all">
            {code}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Content unmounts when the dialog closes, so local state resets naturally.
function EnableFlow({ onFinished, onCancel }: { onFinished: () => void; onCancel: () => void }) {
  const [step, setStep] = useState<EnableStep>("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enableData, setEnableData] = useState<EnableData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const startSetup = async () => {
    setLoading(true);
    setError("");
    const { data, error } = await authClient.twoFactor.enable({
      method: "totp",
      password,
    });
    setLoading(false);
    if (error || !data || data.method !== "totp") {
      setError(error?.message || "Failed to start two-factor setup");
      return;
    }
    setEnableData({ totpURI: data.totpURI, backupCodes: data.backupCodes });
    setStep("verify");
  };

  const verifyCode = async () => {
    if (!isTotpCode(code)) {
      setError("Enter the 6-digit code from your authenticator app");
      return;
    }
    setLoading(true);
    setError("");
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setLoading(false);
    if (error) {
      setError(error.message || "Invalid code");
      return;
    }
    setStep("done");
  };

  const secret = enableData ? parseTotpSecret(enableData.totpURI) : null;

  if (step === "password") {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="tf-password">Current password</Label>
          <Input
            id="tf-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your current password"
          />
          <p className="text-muted-foreground text-xs">
            Confirm your password to start the two-factor setup.
          </p>
        </div>
        {error && <ErrorBanner message={error} />}
        <DialogFooter className="-mx-0 -mb-0 gap-2 sm:justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={startSetup} disabled={loading || !password}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Continue
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (step === "verify" && enableData) {
    return (
      <div className="space-y-4">
        <div className="liquid-glass-inner flex flex-col items-center gap-3 rounded-2xl p-4">
          <div className="rounded-lg border bg-white p-3">
            <QRCodeSVG value={enableData.totpURI} size={160} />
          </div>
          <p className="text-muted-foreground text-center text-xs">
            Scan with your authenticator app
          </p>
          <div className="w-full space-y-1.5">
            <Label htmlFor="tf-manual-key" className="text-xs">
              Or enter this key manually
            </Label>
            <div className="flex min-w-0 items-center gap-2">
              <code className="text-foreground min-w-0 flex-1 font-mono text-xs leading-5 break-all">
                {secret ?? "Unavailable"}
              </code>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="tf-code">Verification code</Label>
          <Input
            id="tf-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="tracking-[0.5em]"
          />
        </div>

        {error && <ErrorBanner message={error} />}
        <DialogFooter className="-mx-0 -mb-0 gap-2 sm:justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={verifyCode} disabled={loading || code.length !== 6}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Verify and enable
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-full bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        Two-factor authentication is now enabled
      </div>
      <BackupCodesList codes={enableData?.backupCodes ?? []} />
      <p className="text-muted-foreground text-xs">
        Store these codes somewhere safe. they are the only way to sign in if you lose your
        authenticator.
      </p>
      <p className="text-muted-foreground text-xs">
        Your other devices are signed out. sign in again with your authenticator where needed.
      </p>
      <DialogFooter className="-mx-0 -mb-0 sm:justify-end">
        <Button onClick={onFinished}>Done</Button>
      </DialogFooter>
    </div>
  );
}

function PasswordActionFlow({
  mode,
  onSuccess,
  onCancel,
}: {
  mode: Extract<TwoFactorDialogMode, "disable" | "backup-codes">;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null);

  const submit = async () => {
    setLoading(true);
    setError("");
    if (mode === "disable") {
      const { error } = await authClient.twoFactor.disable({ password });
      setLoading(false);
      if (error) {
        setError(error.message || "Failed to disable two-factor");
        return;
      }
      onSuccess();
      return;
    }
    const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
    setLoading(false);
    if (error || !data) {
      setError(error?.message || "Failed to generate backup codes");
      return;
    }
    setGeneratedCodes(data.backupCodes);
  };

  if (mode === "backup-codes" && generatedCodes) {
    return (
      <div className="space-y-4">
        <BackupCodesList codes={generatedCodes} />
        <p className="text-muted-foreground text-xs">
          Your previous backup codes no longer work. Store these safely.
        </p>
        <DialogFooter className="-mx-0 -mb-0 sm:justify-end">
          <Button onClick={onSuccess}>Done</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="tf-action-password">Current password</Label>
        <Input
          id="tf-action-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your current password"
        />
      </div>
      {error && <ErrorBanner message={error} />}
      <DialogFooter className="-mx-0 -mb-0 gap-2 sm:justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          disabled={loading || !password}
          variant={mode === "disable" ? "destructive" : "default"}
        >
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {mode === "disable" ? "Turn off" : "Generate"}
        </Button>
      </DialogFooter>
    </div>
  );
}

export function TwoFactorDialog({
  open,
  onOpenChange,
  mode,
  onStateChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: TwoFactorDialogMode;
  onStateChange: () => void;
}) {
  const close = () => {
    onOpenChange(false);
    onStateChange();
  };
  const finish = () => {
    onStateChange();
    onOpenChange(false);
  };
  const header = TITLES[mode];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="gap-1">
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            {header.title}
          </DialogTitle>
          <DialogDescription>{header.description}</DialogDescription>
        </DialogHeader>

        {mode === "enable" ? (
          <EnableFlow onFinished={finish} onCancel={close} />
        ) : (
          <PasswordActionFlow mode={mode} onSuccess={finish} onCancel={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}
