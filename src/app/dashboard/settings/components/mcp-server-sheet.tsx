"use client";

import { useCallback, useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/chat/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, CheckCircle, ExternalLink, Loader2, PlugZap } from "lucide-react";
import {
  normalizeMcpServerName,
  validateMcpServerName,
  validateMcpUrl,
  type McpToolPolicy,
} from "@/lib/mcp/shared";
import type {
  McpOAuthStart,
  McpOAuthStatus,
  McpServer,
  McpServerInput,
  McpTestResult,
} from "@/hooks/use-mcp-servers";

/** How often the sheet asks whether a browser sign-in has finished. */
const OAUTH_POLL_INTERVAL_MS = 1_500;

/** One policy per server: the default for every tool it contributes. */
const POLICY_OPTIONS: { value: McpToolPolicy; label: string; hint: string }[] = [
  { value: "ask", label: "Ask", hint: "Ask for approval before running a tool" },
  { value: "allow", label: "Allow", hint: "Run tools automatically" },
  { value: "off", label: "Block", hint: "Never run tools from this server" },
];

interface McpServerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server being edited, or null when adding. */
  server: McpServer | null;
  onSave: (input: McpServerInput) => Promise<unknown>;
  onTest: (id: string, input: { url: string; token?: string }) => Promise<McpTestResult>;
  /** Begin an OAuth sign-in for a saved server. */
  onStartOAuth: (id: string) => Promise<McpOAuthStart>;
  /** Poll a running OAuth sign-in. */
  onOAuthStatus: (id: string) => Promise<McpOAuthStatus>;
  /** Forget a server's OAuth sign-in. */
  onSignOutOAuth: (id: string) => Promise<void>;
}

export function McpServerSheet({
  open,
  onOpenChange,
  server,
  onSave,
  onTest,
  onStartOAuth,
  onOAuthStatus,
  onSignOutOAuth,
}: McpServerSheetProps) {
  const isEditing = server !== null;

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [token, setToken] = useState("");
  const [toolPolicy, setToolPolicy] = useState<McpToolPolicy>("ask");
  const [enabled, setEnabled] = useState(true);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  /** Which input a validation message belongs to, rendered under it. */
  const [fieldError, setFieldError] = useState<{ field: "name" | "url"; message: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  /** OAuth sign-in state for a saved server. */
  const [hasOAuth, setHasOAuth] = useState(false);
  const [oauthPhase, setOauthPhase] = useState<"idle" | "pending" | "succeeded" | "failed">("idle");
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);

  /**
   * Result of folding what the user typed into a name Pi accepts. Folding
   * happens when the field is left rather than on every keystroke: a fold that
   * drops trailing separators would swallow the space in "HA Admin" before it
   * could become an underscore, and re-writing the value mid-edit moves the
   * caret.
   */
  const foldedName = normalizeMcpServerName(name);

  /** Clear the message under a field once the user edits it again. */
  const clearFieldError = (field: "name" | "url") => {
    setFieldError((current) => (current?.field === field ? null : current));
  };

  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? "");
    setUrl(server?.url ?? "");
    setDescription(server?.description ?? "");
    setToken("");
    setToolPolicy(server?.toolPolicy ?? "ask");
    setEnabled(server?.enabled ?? true);
    setError(null);
    setFieldError(null);
    setTestResult(null);
    setHasOAuth(server?.hasOAuth ?? false);
    setOauthPhase("idle");
    setOauthUrl(null);
    setOauthError(null);
    setOauthBusy(false);
  }, [open, server]);

  // Follow a browser sign-in until it settles or the sheet closes.
  useEffect(() => {
    const serverId = server?.id;
    if (!open || oauthPhase !== "pending" || !serverId) return;

    let cancelled = false;
    const poll = setInterval(() => {
      void (async () => {
        try {
          const status = await onOAuthStatus(serverId);
          if (cancelled) return;
          if (status.status === "succeeded") {
            setHasOAuth(true);
            setOauthPhase("succeeded");
            setOauthUrl(null);
          } else if (status.status === "failed") {
            setOauthPhase("failed");
            setOauthError(status.error ?? "The sign-in failed.");
          }
        } catch (err) {
          // A lost poll is not a failed sign-in: keep the last state.
          console.error("Failed to read the MCP OAuth sign-in state:", err);
        }
      })();
    }, OAUTH_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [open, oauthPhase, server?.id, onOAuthStatus]);

  const handleTest = useCallback(async () => {
    const urlError = validateMcpUrl(url.trim());
    if (urlError) {
      setFieldError({ field: "url", message: urlError });
      return;
    }

    setTesting(true);
    setError(null);
    setFieldError(null);
    setTestResult(null);
    try {
      // An unchanged stored token is represented by an empty field: let the
      // server use the credential it already has.
      const result = await onTest(server?.id ?? "new", {
        url: url.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      setTestResult(result);
      if (!result.success && result.error) setError(result.error);
    } finally {
      setTesting(false);
    }
  }, [onTest, server, token, url]);

  const handleSignIn = useCallback(async () => {
    if (!server) return;
    setOauthBusy(true);
    setOauthError(null);
    setTestResult(null);
    try {
      const result = await onStartOAuth(server.id);
      if (result.status === "succeeded") {
        setHasOAuth(true);
        setOauthPhase("succeeded");
        return;
      }
      if (!result.authorizationUrl) {
        setOauthPhase("failed");
        setOauthError("The server did not return a sign-in URL.");
        return;
      }
      setOauthUrl(result.authorizationUrl);
      setOauthPhase("pending");
      // Best effort: a blocked popup still leaves the link below.
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setOauthPhase("failed");
      setOauthError((err as Error).message || "Failed to start the sign-in");
    } finally {
      setOauthBusy(false);
    }
  }, [onStartOAuth, server]);

  const handleSignOut = useCallback(async () => {
    if (!server) return;
    setOauthBusy(true);
    setOauthError(null);
    try {
      await onSignOutOAuth(server.id);
      setHasOAuth(false);
      setOauthPhase("idle");
      setOauthUrl(null);
    } catch (err) {
      setOauthError((err as Error).message || "Failed to sign out");
    } finally {
      setOauthBusy(false);
    }
  }, [onSignOutOAuth, server]);

  const handleSave = useCallback(async () => {
    const normalizedName = normalizeMcpServerName(name);
    const trimmedUrl = url.trim();

    const nameError = validateMcpServerName(normalizedName);
    if (nameError) {
      setFieldError({ field: "name", message: nameError });
      return;
    }
    const urlError = validateMcpUrl(trimmedUrl);
    if (urlError) {
      setFieldError({ field: "url", message: urlError });
      return;
    }

    setSaving(true);
    setError(null);
    setFieldError(null);
    try {
      await onSave({
        name: normalizedName,
        url: trimmedUrl,
        description: description.trim(),
        toolPolicy,
        enabled,
        // An empty field leaves an existing token alone; a typed value replaces
        // it. Clearing is offered explicitly below.
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message || "Failed to save the server");
    } finally {
      setSaving(false);
    }
  }, [description, enabled, name, onOpenChange, onSave, token, toolPolicy, url]);

  const handleClearToken = useCallback(async () => {
    if (!server) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ token: "" });
      setToken("");
    } catch (err) {
      setError((err as Error).message || "Failed to clear the token");
    } finally {
      setSaving(false);
    }
  }, [onSave, server]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none">
        <div className="flex h-full flex-col">
          <SheetHeader className="px-6 pt-6 pb-4">
            <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
              {isEditing ? "Edit MCP server" : "Add MCP server"}
            </SheetTitle>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <div className="space-y-2">
              <Label className="text-sm">Name</Label>
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  clearFieldError("name");
                }}
                onBlur={() => setName(foldedName)}
                placeholder="homeassistant"
                autoComplete="off"
              />
              {fieldError?.field === "name" ? (
                <p className="text-destructive text-xs">{fieldError.message}</p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Names this server&apos;s tools. Spaces and punctuation become underscores, e.g.{" "}
                  <span className="break-all">{`mcp__${foldedName || "homeassistant"}__HassTurnOn`}</span>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Endpoint URL</Label>
              <Input
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  clearFieldError("url");
                }}
                placeholder="https://homeassistant.local:8123/api/mcp"
                autoComplete="off"
                spellCheck={false}
              />
              {fieldError?.field === "url" ? (
                <p className="text-destructive text-xs">{fieldError.message}</p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  A streamable HTTP MCP endpoint. Stdio servers (a local command) are not supported.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Access token</Label>
              <Input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={server?.hasToken ? "Type to replace stored value" : "Optional"}
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">
                Sent as <span className="font-mono">Authorization: Bearer …</span>. Stored
                encrypted.
              </p>
              {server?.hasToken && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={handleClearToken}
                  disabled={saving}
                >
                  Remove stored token
                </Button>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-sm">OAuth sign-in</Label>
              {!isEditing ? (
                <p className="text-muted-foreground text-xs">
                  Save this server first, then sign in here.
                </p>
              ) : oauthPhase === "pending" ? (
                <div className="space-y-2">
                  <p className="text-muted-foreground flex items-center gap-2 text-xs">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Waiting for you to finish signing in…
                  </p>
                  {oauthUrl && (
                    <div className="bg-muted border-border flex items-start gap-2 rounded-lg border px-3 py-2">
                      <code className="min-w-0 flex-1 text-[11px] break-all">{oauthUrl}</code>
                      <CopyButton text={oauthUrl} label="Copy the sign-in URL" />
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {oauthUrl && (
                      <Button size="sm" variant="secondary" asChild>
                        <a href={oauthUrl} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-3.5 w-3.5" />
                          Open sign-in page
                        </a>
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={handleSignIn}
                      disabled={oauthBusy}
                    >
                      Start over
                    </Button>
                  </div>
                </div>
              ) : hasOAuth || oauthPhase === "succeeded" ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                    <CheckCircle className="h-3.5 w-3.5" />
                    Signed in
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={handleSignOut}
                    disabled={oauthBusy}
                  >
                    Sign out
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-9 text-xs font-medium"
                    onClick={handleSignIn}
                    disabled={oauthBusy}
                  >
                    {oauthBusy ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ExternalLink className="mr-2 h-3.5 w-3.5" />
                    )}
                    Sign in
                  </Button>
                  <p className="text-muted-foreground text-xs">
                    For servers that ask clients to sign in. A stored access token is used instead
                    of OAuth.
                  </p>
                </div>
              )}
              {oauthError && <p className="text-destructive text-xs">{oauthError}</p>}
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Description</Label>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Control the smart home"
              />
              <p className="text-muted-foreground text-xs">
                One line telling the assistant what this server is for.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Tool approval</Label>
              <Select
                value={toolPolicy}
                onValueChange={(value) => {
                  if (value) setToolPolicy(value as McpToolPolicy);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) =>
                      POLICY_OPTIONS.find((option) => option.value === value)?.label ?? "Ask"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {POLICY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {POLICY_OPTIONS.find((option) => option.value === toolPolicy)?.hint}
              </p>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <Label className="text-sm">Enabled</Label>
                <p className="text-muted-foreground text-xs">
                  Connect this server to your conversations.
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            {error && (
              <div className="text-destructive bg-destructive/10 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            )}

            {testResult?.success && (
              <div className="space-y-2 rounded-xl bg-green-500/10 px-4 py-3 text-sm text-green-600 dark:text-green-400">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-words">
                    Connected to {testResult.serverName ?? "the server"}:{" "}
                    {testResult.tools?.length ?? 0} tool
                    {testResult.tools?.length === 1 ? "" : "s"}
                  </span>
                </div>
                {testResult.tools && testResult.tools.length > 0 && (
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
                    {testResult.tools.map((tool) => (
                      <li key={tool.name} className="break-all">
                        {tool.name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 gap-2 border-t px-6 py-4">
            <Button
              type="button"
              variant="secondary"
              className="h-9 text-xs font-medium"
              onClick={handleTest}
              disabled={testing || saving || !url.trim()}
            >
              {testing ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlugZap className="mr-2 h-3.5 w-3.5" />
              )}
              Test
            </Button>
            <Button
              type="button"
              className="h-9 flex-1 text-xs font-medium"
              onClick={handleSave}
              disabled={saving || testing || !name.trim() || !url.trim()}
            >
              {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              {isEditing ? "Save changes" : "Add server"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
