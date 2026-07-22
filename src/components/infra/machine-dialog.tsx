"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plug, CheckCircle, AlertCircle, KeyRound, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { postJson, patchJson } from "@/lib/http";
import type { InfraMachine } from "@/app/dashboard/infra/page";

interface MachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  machine: InfraMachine | null;
}

export function MachineDialog({ open, onOpenChange, onSuccess, machine }: MachineDialogProps) {
  const isEditing = !!machine;

  // Form state
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState<"key" | "password">("key");
  const [password, setPassword] = useState("");

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // After successful creation with key auth, show the public key
  const [generatedPublicKey, setGeneratedPublicKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Load existing machine data
  useEffect(() => {
    if (machine && open) {
      setName(machine.name);
      setHost(machine.host);
      setPort(String(machine.port));
      setUsername(machine.username);
      setAuthMethod(machine.authMethod as "key" | "password");
      setPassword("");
      setTestResult(null);
      setError(null);
      setGeneratedPublicKey(null);
      setCopiedKey(false);
    } else if (!machine && open) {
      // Reset for new machine
      setName("");
      setHost("");
      setPort("22");
      setUsername("");
      setAuthMethod("key");
      setPassword("");
      setTestResult(null);
      setError(null);
      setGeneratedPublicKey(null);
      setCopiedKey(false);
    }
  }, [machine, open]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setSubmitting(true);

      const body: Record<string, unknown> = {
        name,
        host,
        port: parseInt(port, 10) || 22,
        username,
        authMethod,
      };

      if (authMethod === "password") {
        body.password = password;
      }

      try {
        const response: { machine: InfraMachine; authorizedKeysEntry?: string } =
          isEditing && machine
            ? await patchJson(`/api/infra/machines/${machine.id}`, body)
            : await postJson("/api/infra/machines", body);

        // If key auth and we got a public key, show it
        if (authMethod === "key" && response.authorizedKeysEntry) {
          setGeneratedPublicKey(response.authorizedKeysEntry);
        } else {
          onOpenChange(false);
          onSuccess();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save machine");
      } finally {
        setSubmitting(false);
      }
    },
    [name, host, port, username, authMethod, password, isEditing, machine, onOpenChange, onSuccess],
  );

  const handleDone = useCallback(() => {
    onOpenChange(false);
    onSuccess();
  }, [onOpenChange, onSuccess]);

  const handleTest = useCallback(async () => {
    if (!machine?.id) return;
    setTesting(true);
    setTestResult(null);

    try {
      const data = await postJson<{ ok: boolean; message: string; hostname?: string | null }>(
        "/api/infra/machines/test-connection",
        { id: machine.id },
      );
      setTestResult({
        ok: data.ok,
        message: data.hostname ? `${data.message} (${data.hostname})` : data.message,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "Connection test failed",
      });
    } finally {
      setTesting(false);
    }
  }, [machine]);

  const handleCopyKey = useCallback(async () => {
    if (!generatedPublicKey) return;
    await navigator.clipboard.writeText(generatedPublicKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  }, [generatedPublicKey]);

  // Show public key setup screen after creation
  if (generatedPublicKey) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <KeyRound className="text-primary mb-2 h-8 w-8" />
              <span>Setup SSH Access</span>
            </DialogTitle>
            <DialogDescription>
              Saale generated an ED25519 key pair for{" "}
              <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
                {username}@{host}:{port || 22}
              </code>
              . Add the public key below to the server&apos;s{" "}
              <code className="bg-muted rounded px-1.5 py-0.5 text-xs">~/.ssh/authorized_keys</code>{" "}
              file.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Public key */}
            <div className="space-y-2">
              <Label>Public key</Label>
              <div className="flex items-center gap-2">
                <pre className="bg-muted/50 min-h-0 flex-1 overflow-x-auto rounded-lg border p-3 font-mono text-[10px] break-all">
                  {generatedPublicKey}
                </pre>
                <Button size="sm" variant="secondary" onClick={handleCopyKey} className="shrink-0">
                  {copiedKey ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400">
              After adding the key to the server, click &quot;Done&quot; and then use &quot;Test
              Connection&quot; to verify everything works.
            </div>
          </div>

          <DialogFooter>
            <Button type="button" onClick={handleDone} className="h-8">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Machine" : "Add Machine"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the connection details for this machine."
              : "Register a remote machine the agent can connect to via SSH."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="infra-name">Name</Label>
            <Input
              id="infra-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="prod-web-01"
              required
              className="h-9"
            />
          </div>

          {/* Host + Port */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="infra-host">Host</Label>
              <Input
                id="infra-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="example.com or 192.168.1.1"
                required
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="infra-port">Port</Label>
              <Input
                id="infra-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="h-9"
              />
            </div>
          </div>

          {/* Username */}
          <div className="space-y-2">
            <Label htmlFor="infra-username">Username</Label>
            <Input
              id="infra-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="deploy"
              required
              className="h-9"
            />
          </div>

          {/* Auth Method */}
          <div className="space-y-2">
            <Label>Authentication</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAuthMethod("key")}
                className={cn(
                  "flex-1 rounded-lg border px-3 py-2 text-sm transition-colors",
                  authMethod === "key"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-muted/50 bg-transparent",
                )}
              >
                <KeyRound className="mr-1.5 inline h-3.5 w-3.5" />
                SSH Key
              </button>
              <button
                type="button"
                onClick={() => setAuthMethod("password")}
                className={cn(
                  "flex-1 rounded-lg border px-3 py-2 text-sm transition-colors",
                  authMethod === "password"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-muted/50 bg-transparent",
                )}
              >
                Password
              </button>
            </div>
          </div>

          {/* Credential */}
          {authMethod === "key" ? (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-600 dark:text-emerald-400">
              Saale will generate an ED25519 key pair automatically. After saving, you&apos;ll see
              the public key to add to the server&apos;s{" "}
              <code className="bg-muted rounded px-1 py-0.5">~/.ssh/authorized_keys</code>.
              {isEditing && (
                <span className="text-muted-foreground mt-1 block">
                  Leave as-is to keep the existing key.
                </span>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="infra-password">Password</Label>
              <Input
                id="infra-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required={!isEditing}
                className="h-9"
              />
              {isEditing && (
                <p className="text-muted-foreground text-[10px]">
                  Leave empty to keep the existing password.
                </p>
              )}
            </div>
          )}

          {/* Test connection (edit mode only) */}
          {isEditing && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={testing}
                className="h-8"
              >
                {testing ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plug className="mr-1.5 h-3.5 w-3.5" />
                )}
                Test Connection
              </Button>

              {testResult && (
                <div
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                  )}
                >
                  {testResult.ok ? (
                    <CheckCircle className="h-3.5 w-3.5" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5" />
                  )}
                  {testResult.message}
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="h-8"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} className="h-8">
              {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {isEditing ? "Save" : "Add Machine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
