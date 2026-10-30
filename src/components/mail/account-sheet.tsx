"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { AlertCircle, CheckCircle, Loader2, Sparkles, Settings2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { postJson, patchJson } from "@/lib/http";
import type { EmailAccount } from "@/types/shared";

interface AccountSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /** When set, the sheet edits this account instead of creating a new one. */
  account?: EmailAccount | null;
}

interface ServerConfig {
  host: string;
  port: number;
  secure: boolean;
}

interface AutodiscoverResponse {
  imap: ServerConfig | null;
  smtp: ServerConfig | null;
  source: "srv" | "probe" | null;
}

/** Discovery outcome for this session, plus whether the lookup itself failed. */
interface Discovery extends AutodiscoverResponse {
  failed: boolean;
}

/**
 * Conventional ports for a fresh account. Hosts deliberately start empty: a
 * prefilled host silently points the account at a provider the user never
 * chose (it used to be imap.gmail.com, which broke every non-Gmail signup).
 */
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;

/** Ports are free-text fields, so fall back to the conventional port when empty. */
function resolvePort(port: string, fallback: number): number {
  const parsed = Number.parseInt(port, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function emailDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at > 0 && at < address.length - 1 ? address.slice(at + 1) : null;
}

export function AccountSheet({ open, onOpenChange, onSuccess, account }: AccountSheetProps) {
  const isEdit = !!account;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(String(DEFAULT_IMAP_PORT));
  const [imapSecure, setImapSecure] = useState(true);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(String(DEFAULT_SMTP_PORT));
  const [smtpSecure, setSmtpSecure] = useState(true);

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    imap?: { success: boolean; error?: string };
    smtp?: { success: boolean; error?: string };
  } | null>(null);
  const [error, setError] = useState("");

  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<Discovery | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Hosts the user typed themselves. autodiscovery must never overwrite those. */
  const editedRef = useRef({ imap: false, smtp: false });

  const resetForm = useCallback(() => {
    setEmail(account?.email ?? "");
    setPassword("");
    setImapHost(account?.imapHost ?? "");
    setImapPort(String(account?.imapPort ?? DEFAULT_IMAP_PORT));
    setImapSecure(account?.imapSecure ?? true);
    setSmtpHost(account?.smtpHost ?? "");
    setSmtpPort(String(account?.smtpPort ?? DEFAULT_SMTP_PORT));
    setSmtpSecure(account?.smtpSecure ?? true);
    setTestResult(null);
    setError("");
    setDiscovered(null);
    setDiscovering(false);
    setShowAdvanced(false);
    editedRef.current = { imap: false, smtp: false };
  }, [account]);

  useEffect(() => {
    resetForm();
  }, [open, resetForm]);

  // Abandon an in-flight lookup when the sheet closes or unmounts.
  useEffect(() => {
    if (open) return;
    abortRef.current?.abort();
    abortRef.current = null;
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, [open]);

  /**
   * Apply a discovery result to the form. A server that was not found is
   * cleared rather than left holding a previous value. a half-filled pair
   * (IMAP from a stale default, SMTP from the probe) is the bug this guards.
   */
  const applyDiscovery = useCallback((result: Discovery) => {
    setDiscovered(result);

    if (!editedRef.current.imap) {
      setImapHost(result.imap?.host ?? "");
      if (result.imap) {
        setImapPort(String(result.imap.port));
        setImapSecure(result.imap.secure);
      }
    }
    if (!editedRef.current.smtp) {
      setSmtpHost(result.smtp?.host ?? "");
      if (result.smtp) {
        setSmtpPort(String(result.smtp.port));
        setSmtpSecure(result.smtp.secure);
      }
    }
  }, []);

  const runAutodiscover = useCallback(
    async (address: string) => {
      // Supersede any lookup still in flight: a slow answer for a previously
      // typed address must never overwrite the result for the current one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setDiscovering(true);
      setDiscovered(null);

      try {
        const data = await postJson<AutodiscoverResponse>(
          "/api/email/autodiscover",
          { email: address },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        applyDiscovery({ ...data, failed: false });
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("Server settings lookup failed:", err);
        applyDiscovery({ imap: null, smtp: null, source: null, failed: true });
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setDiscovering(false);
        }
      }
    },
    [applyDiscovery],
  );

  const triggerAutodiscover = useCallback(
    (address: string) => {
      if (account) return; // keep the saved server settings while editing
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const trimmed = address.trim();
        if (!trimmed.includes("@")) {
          setDiscovered(null);
          return;
        }
        void runAutodiscover(trimmed);
      }, 600);
    },
    [account, runAutodiscover],
  );

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
        // Fall back to the stored password when editing without a new one
        password: password || undefined,
        accountId: account?.id,
        imapHost,
        imapPort: resolvePort(imapPort, DEFAULT_IMAP_PORT),
        imapSecure,
        smtpHost,
        smtpPort: resolvePort(smtpPort, DEFAULT_SMTP_PORT),
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
      const payload: Record<string, unknown> = {
        email,
        imapHost: imapHost.trim(),
        imapPort: resolvePort(imapPort, DEFAULT_IMAP_PORT),
        imapSecure,
        smtpHost: smtpHost.trim(),
        smtpPort: resolvePort(smtpPort, DEFAULT_SMTP_PORT),
        smtpSecure,
      };
      if (password) payload.password = password;

      if (account) {
        await patchJson(`/api/email/accounts/${account.id}`, payload);
      } else {
        const created = await postJson<{
          sync?: { errors?: string[]; pending?: boolean };
        }>("/api/email/accounts", payload);
        const syncErrors = created.sync?.errors ?? [];
        if (syncErrors.length > 0) {
          // The account exists, but it is not usable yet. say so instead of
          // closing the sheet as if the setup had worked.
          toast.error("Account saved, but the first sync failed", {
            description: `${syncErrors[0]}. edit the account to fix its server settings.`,
          });
        } else if (created.sync?.pending) {
          toast.info("Account saved. the first sync is still running");
        }
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

  const hasBothServers =
    !!discovered && !discovered.failed && !!discovered.imap && !!discovered.smtp;
  const foundOne =
    !!discovered && !discovered.failed && !hasBothServers && !!(discovered.imap || discovered.smtp);
  const missingProtocol = discovered?.imap ? "SMTP" : "IMAP";
  const domain = emailDomain(email.trim());
  const canSave = !!email && !!imapHost.trim() && !!smtpHost.trim() && (isEdit || !!password);
  const canTest = !!email && !!imapHost.trim() && !!smtpHost.trim() && (isEdit || !!password);
  const discoveryLabel = discovered?.source === "srv" ? "Detected via DNS" : "Detected via probe";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[520px] sm:max-w-none">
        <div className="flex h-full flex-col">
          {/* Header */}
          <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
            <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
              {isEdit ? "Edit Email Account" : "Add Email Account"}
            </SheetTitle>
          </SheetHeader>

          {/* Form */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="flex flex-col gap-4">
              {/* Email & Password */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="account-email" className="text-xs">
                    Email
                  </Label>
                  <div className="relative">
                    <Input
                      id="account-email"
                      value={email}
                      onChange={handleEmailChange}
                      placeholder="you@example.com"
                      className="rounded-full border-0 bg-transparent pr-10 shadow-none"
                    />
                    {discovering && (
                      <Loader2 className="text-muted-foreground absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin" />
                    )}
                    {hasBothServers && !discovering && (
                      <Sparkles className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-amber-500" />
                    )}
                  </div>
                  {discovering && (
                    <p className="text-muted-foreground text-xs">Detecting server settings…</p>
                  )}
                  {hasBothServers && !discovering && (
                    <p className="text-muted-foreground flex items-center gap-1 text-xs">
                      <Sparkles className="h-3 w-3" />
                      {discoveryLabel}. settings filled in
                    </p>
                  )}
                  {foundOne && !discovering && (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      {missingProtocol} settings not detected. enter them below
                    </p>
                  )}
                  {discovered && !discovered.failed && !hasBothServers && !foundOne && domain && (
                    <p className="text-muted-foreground text-xs">
                      No IMAP/SMTP server found for {domain}. enter your provider&apos;s settings
                      below
                    </p>
                  )}
                  {discovered?.failed && (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      Settings lookup failed. enter your provider&apos;s server settings below
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="account-password" className="text-xs">
                    {isEdit ? "New Password / App Password" : "Password / App Password"}
                  </Label>
                  <Input
                    id="account-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="rounded-full border-0 bg-transparent shadow-none"
                  />
                  {isEdit && (
                    <p className="text-muted-foreground text-xs">
                      Leave blank to keep the current password
                    </p>
                  )}
                </div>
              </div>

              {/* Server settings toggle */}
              {hasBothServers && !showAdvanced && (
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

              {/* Server settings. always visible until *both* servers are known */}
              {(isEdit || showAdvanced || !hasBothServers) && (
                <>
                  <Separator className="border-border/30" />

                  {/* IMAP Settings */}
                  <div>
                    <h3 className="mb-2 text-sm font-medium">IMAP Settings</h3>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,6rem)_auto]">
                      <div className="space-y-2">
                        <Label htmlFor="imap-host" className="text-xs">
                          Host
                        </Label>
                        <Input
                          id="imap-host"
                          value={imapHost}
                          onChange={(e) => {
                            editedRef.current.imap = true;
                            setImapHost(e.target.value);
                          }}
                          placeholder="imap.example.com"
                          className="rounded-full border-0 bg-transparent shadow-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="imap-port" className="text-xs">
                          Port
                        </Label>
                        <Input
                          id="imap-port"
                          type="number"
                          inputMode="numeric"
                          value={imapPort}
                          onChange={(e) => setImapPort(e.target.value)}
                          className="rounded-full border-0 bg-transparent shadow-none"
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
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,6rem)_auto]">
                      <div className="space-y-2">
                        <Label htmlFor="smtp-host" className="text-xs">
                          Host
                        </Label>
                        <Input
                          id="smtp-host"
                          value={smtpHost}
                          onChange={(e) => {
                            editedRef.current.smtp = true;
                            setSmtpHost(e.target.value);
                          }}
                          placeholder="smtp.example.com"
                          className="rounded-full border-0 bg-transparent shadow-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="smtp-port" className="text-xs">
                          Port
                        </Label>
                        <Input
                          id="smtp-port"
                          type="number"
                          inputMode="numeric"
                          value={smtpPort}
                          onChange={(e) => setSmtpPort(e.target.value)}
                          className="rounded-full border-0 bg-transparent shadow-none"
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
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span className="break-words">{error}</span>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="border-border/30 border-t px-6 py-4">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                className="h-9 text-xs font-medium"
                onClick={handleTest}
                disabled={testing || !canTest}
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
                className="h-9 text-xs font-medium"
                onClick={handleSave}
                disabled={saving || !canSave}
              >
                {saving ? "Saving..." : isEdit ? "Save Changes" : "Save Account"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
