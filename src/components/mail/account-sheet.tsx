"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { AlertCircle, CheckCircle, Loader2, Sparkles, Settings2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { postJson } from "@/lib/http";

interface AccountSheetProps {
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

export function AccountSheet({ open, onOpenChange, onSuccess }: AccountSheetProps) {
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
        const data = await postJson<{
          imap: ServerConfig | null;
          smtp: ServerConfig | null;
          source: "srv" | "probe" | null;
        }>("/api/email/autodiscover", { email: trimmed });
        setDiscovered(data);

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
      const data = await postJson<{ results: typeof testResult }>("/api/email/test-connection", {
        email,
        password,
        imapHost,
        imapPort,
        imapSecure,
        smtpHost,
        smtpPort,
        smtpSecure,
      });
      setTestResult(data.results);
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
      await postJson("/api/email/accounts", {
        email,
        password,
        imapHost,
        imapPort,
        imapSecure,
        smtpHost,
        smtpPort,
        smtpSecure,
      });

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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[520px] sm:max-w-none">
        <div className="flex h-full flex-col">
          {/* Header */}
          <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
            <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
              Add Email Account
            </SheetTitle>
          </SheetHeader>

          {/* Form */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="flex flex-col gap-4">
              {/* Email & Password */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs">Email</Label>
                  <div className="relative">
                    <Input
                      value={email}
                      onChange={handleEmailChange}
                      placeholder="you@example.com"
                      className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
                    />
                    {discovering && (
                      <Loader2 className="text-muted-foreground absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin" />
                    )}
                    {hasDiscovery && !discovering && (
                      <Sparkles className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-amber-500" />
                    )}
                  </div>
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
                  <Label className="text-xs">Password / App Password</Label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
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
                  <Separator className="border-border/30" />

                  {/* IMAP Settings */}
                  <div>
                    <h3 className="mb-2 text-sm font-medium">IMAP Settings</h3>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-2">
                        <Label className="text-xs">Host</Label>
                        <Input
                          value={imapHost}
                          onChange={(e) => setImapHost(e.target.value)}
                          className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">Port</Label>
                        <Input
                          type="number"
                          value={imapPort}
                          onChange={(e) => setImapPort(parseInt(e.target.value))}
                          className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
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

                  <Separator className="border-border/30" />

                  {/* SMTP Settings */}
                  <div>
                    <h3 className="mb-2 text-sm font-medium">SMTP Settings</h3>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-2">
                        <Label className="text-xs">Host</Label>
                        <Input
                          value={smtpHost}
                          onChange={(e) => setSmtpHost(e.target.value)}
                          className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">Port</Label>
                        <Input
                          type="number"
                          value={smtpPort}
                          onChange={(e) => setSmtpPort(parseInt(e.target.value))}
                          className="liquid-glass-inner rounded-full border-0 bg-transparent shadow-none"
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
                <div className="border-border/30 bg-muted/50 flex flex-col gap-2 rounded-2xl border p-3">
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
                <div className="text-destructive bg-destructive/10 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="border-border/30 border-t px-6 py-4">
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                className="liquid-glass-pill h-9 rounded-full text-xs font-medium"
                onClick={handleTest}
                disabled={testing}
              >
                {testing ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Testing...
                  </>
                ) : (
                  "Test Connection"
                )}
              </Button>
              <Button
                className="liquid-glass-accent h-9 rounded-full text-xs font-medium"
                onClick={handleSave}
                disabled={saving || !email || !password}
              >
                {saving ? "Saving..." : "Save Account"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
