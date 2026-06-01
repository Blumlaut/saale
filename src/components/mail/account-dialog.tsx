"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";

interface EmailAccount {
  id: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  enabled: boolean;
}

interface AccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function AccountDialog({ open, onOpenChange, onSuccess }: AccountDialogProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState("imap.gmail.com");
  const [imapPort, setImapPort] = useState(993);
  const [imapSecure, setImapSecure] = useState(true);
  const [smtpHost, setSmtpHost] = useState("smtp.gmail.com");
  const [smtpPort, setSmtpPort] = useState(465);
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    imap?: { success: boolean; error?: string };
    smtp?: { success: boolean; error?: string };
  } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open]);

  const resetForm = () => {
    setEmail("");
    setPassword("");
    setImapHost("imap.gmail.com");
    setImapPort(993);
    setImapSecure(true);
    setSmtpHost("smtp.gmail.com");
    setSmtpPort(465);
    setSmtpSecure(true);
    setTestResult(null);
    setError("");
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError("");

    try {
      const res = await fetch("/api/email/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          imapHost,
          imapPort,
          imapSecure,
          smtpHost,
          smtpPort,
          smtpSecure,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setTestResult(data.results);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");

    try {
      const res = await fetch("/api/email/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          imapHost,
          imapPort,
          imapSecure,
          smtpHost,
          smtpPort,
          smtpSecure,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save account");
      }

      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Email Account</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Email & Password */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Password / App Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </div>

          <Separator />

          {/* IMAP Settings */}
          <div>
            <h3 className="mb-2 text-sm font-medium">IMAP Settings</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Host</Label>
                <Input value={imapHost} onChange={(e) => setImapHost(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Port</Label>
                <Input
                  type="number"
                  value={imapPort}
                  onChange={(e) => setImapPort(parseInt(e.target.value))}
                />
              </div>
              <div className="flex items-end gap-2 pb-1">
                <div className="flex items-center gap-2">
                  <Switch checked={imapSecure} onCheckedChange={setImapSecure} id="imap-secure" />
                  <Label htmlFor="imap-secure" className="text-sm">
                    SSL/TLS
                  </Label>
                </div>
              </div>
            </div>
          </div>

          <Separator />

          {/* SMTP Settings */}
          <div>
            <h3 className="mb-2 text-sm font-medium">SMTP Settings</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Host</Label>
                <Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Port</Label>
                <Input
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(parseInt(e.target.value))}
                />
              </div>
              <div className="flex items-end gap-2 pb-1">
                <div className="flex items-center gap-2">
                  <Switch checked={smtpSecure} onCheckedChange={setSmtpSecure} id="smtp-secure" />
                  <Label htmlFor="smtp-secure" className="text-sm">
                    SSL/TLS
                  </Label>
                </div>
              </div>
            </div>
          </div>

          {/* Test result */}
          {testResult && (
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              {testResult.imap && (
                <div className="flex items-center gap-2 text-sm">
                  {testResult.imap.success ? (
                    <>
                      <CheckCircle className="h-4 w-4 text-green-500" />
                      <span className="text-green-600 dark:text-green-400">IMAP connected</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="text-destructive h-4 w-4" />
                      <span className="text-destructive">IMAP: {testResult.imap.error}</span>
                    </>
                  )}
                </div>
              )}
              {testResult.smtp && (
                <div className="flex items-center gap-2 text-sm">
                  {testResult.smtp.success ? (
                    <>
                      <CheckCircle className="h-4 w-4 text-green-500" />
                      <span className="text-green-600 dark:text-green-400">SMTP connected</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="text-destructive h-4 w-4" />
                      <span className="text-destructive">SMTP: {testResult.smtp.error}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-destructive bg-destructive/10 flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={handleTest} disabled={testing}>
              {testing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing...
                </>
              ) : (
                "Test Connection"
              )}
            </Button>
            <Button onClick={handleSave} disabled={saving || !email || !password}>
              {saving ? "Saving..." : "Save Account"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
