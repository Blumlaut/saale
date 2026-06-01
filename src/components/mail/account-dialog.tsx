"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { AlertCircle, CheckCircle, Loader2, Sparkles, Settings2 } from "lucide-react";

interface AccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface ServerConfig {
  host: string;
  port: number;
  secure: boolean;
}

const DEFAULT_IMAP: ServerConfig = { host: "imap.gmail.com", port: 993, secure: true };
const DEFAULT_SMTP: ServerConfig = { host: "smtp.gmail.com", port: 465, secure: true };

export function AccountDialog({ open, onOpenChange, onSuccess }: AccountDialogProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState(DEFAULT_IMAP.host);
  const [imapPort, setImapPort] = useState(DEFAULT_IMAP.port);
  const [imapSecure, setImapSecure] = useState(DEFAULT_IMAP.secure);
  const [smtpHost, setSmtpHost] = useState(DEFAULT_SMTP.host);
  const [smtpPort, setSmtpPort] = useState(DEFAULT_SMTP.port);
  const [smtpSecure, setSmtpSecure] = useState(DEFAULT_SMTP.secure);

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    imap?: { success: boolean; error?: string };
    smtp?: { success: boolean; error?: string };
  } | null>(null);
  const [error, setError] = useState("");

  // Autodiscover state
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<{
    imap: ServerConfig | null;
    smtp: ServerConfig | null;
    source: "srv" | "probe" | null;
  } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetForm = useCallback(() => {
    setEmail("");
    setPassword("");
    setImapHost(DEFAULT_IMAP.host);
    setImapPort(DEFAULT_IMAP.port);
    setImapSecure(DEFAULT_IMAP.secure);
    setSmtpHost(DEFAULT_SMTP.host);
    setSmtpPort(DEFAULT_SMTP.port);
    setSmtpSecure(DEFAULT_SMTP.secure);
    setTestResult(null);
    setError("");
    setDiscovered(null);
    setShowAdvanced(false);
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open, resetForm]);

  // Autodiscover when email changes (debounced)
  const triggerAutodiscover = useCallback((address: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const trimmed = address.trim();
      if (!trimmed.includes("@")) {
        setDiscovered(null);
        return;
      }

      setDiscovering(true);
      setDiscovered(null);

      try {
        const res = await fetch("/api/email/autodiscover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmed }),
        });

        if (res.ok) {
          const data = await res.json();
          setDiscovered(data);

          // Auto-fill if something was found
          if (data.imap) {
            setImapHost(data.imap.host);
            setImapPort(data.imap.port);
            setImapSecure(data.imap.secure);
          }
          if (data.smtp) {
            setSmtpHost(data.smtp.host);
            setSmtpPort(data.smtp.port);
            setSmtpSecure(data.smtp.secure);
          }
        } else {
          setDiscovered({ imap: null, smtp: null, source: null });
        }
      } catch {
        setDiscovered({ imap: null, smtp: null, source: null });
      } finally {
        setDiscovering(false);
      }
    }, 600);
  }, []);

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setEmail(value);
    triggerAutodiscover(value);
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

  const hasDiscovery = discovered && (discovered.imap || discovered.smtp);
  const discoveryLabel =
    discovered?.source === "srv"
      ? "Detected via DNS"
      : discovered?.source === "probe"
        ? "Detected via probe"
        : null;

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
              <div className="relative">
                <Input value={email} onChange={handleEmailChange} placeholder="you@example.com" />
                {discovering && (
                  <Loader2 className="text-muted-foreground absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin" />
                )}
                {hasDiscovery && !discovering && (
                  <Sparkles className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-amber-500" />
                )}
              </div>
              {/* Discovery status */}
              {discovering && (
                <p className="text-muted-foreground text-xs">Detecting server settings…</p>
              )}
              {hasDiscovery && !discovering && (
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Sparkles className="h-3 w-3" />
                  {discoveryLabel} — settings filled in
                </p>
              )}
              {discovered && !hasDiscovery && !discovering && email.includes("@") && (
                <p className="text-muted-foreground text-xs">
                  Could not auto-detect — enter server settings below
                </p>
              )}
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

          {/* Server settings toggle */}
          {hasDiscovery && !showAdvanced && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-xs"
              onClick={() => setShowAdvanced(true)}
            >
              <Settings2 className="mr-1 h-3 w-3" />
              Edit server settings
            </Button>
          )}

          {/* Server settings (collapsible when auto-discovered) */}
          {(showAdvanced || !hasDiscovery) && (
            <>
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
                      <Switch
                        checked={imapSecure}
                        onCheckedChange={setImapSecure}
                        id="imap-secure"
                      />
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
                      <Switch
                        checked={smtpSecure}
                        onCheckedChange={setSmtpSecure}
                        id="smtp-secure"
                      />
                      <Label htmlFor="smtp-secure" className="text-sm">
                        SSL/TLS
                      </Label>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

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
