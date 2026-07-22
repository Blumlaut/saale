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
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Plug, CheckCircle, AlertCircle } from "lucide-react";
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
  const [privateKey, setPrivateKey] = useState("");
  const [password, setPassword] = useState("");
  const [passPhrase, setPassPhrase] = useState("");

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load existing machine data
  useEffect(() => {
    if (machine && open) {
      setName(machine.name);
      setHost(machine.host);
      setPort(String(machine.port));
      setUsername(machine.username);
      setAuthMethod(machine.authMethod as "key" | "password");
      setPrivateKey("");
      setPassword("");
      setPassPhrase("");
      setTestResult(null);
      setError(null);
    } else if (!machine && open) {
      // Reset for new machine
      setName("");
      setHost("");
      setPort("22");
      setUsername("");
      setAuthMethod("key");
      setPrivateKey("");
      setPassword("");
      setPassPhrase("");
      setTestResult(null);
      setError(null);
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

      if (authMethod === "key") {
        body.privateKey = privateKey;
      } else {
        body.password = password;
      }

      if (passPhrase) {
        body.passPhrase = passPhrase;
      }

      try {
        if (isEditing && machine) {
          await patchJson(`/api/infra/machines/${machine.id}`, body);
        } else {
          await postJson("/api/infra/machines", body);
        }
        onOpenChange(false);
        onSuccess();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save machine");
      } finally {
        setSubmitting(false);
      }
    },
    [
      name,
      host,
      port,
      username,
      authMethod,
      privateKey,
      password,
      passPhrase,
      isEditing,
      machine,
      onOpenChange,
      onSuccess,
    ],
  );

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
            <div className="space-y-2">
              <Label htmlFor="infra-key">Private Key</Label>
              <Textarea
                id="infra-key"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                required={!isEditing}
                className="min-h-[120px] font-mono text-xs"
              />
              {isEditing && (
                <p className="text-muted-foreground text-[10px]">
                  Leave empty to keep the existing key.
                </p>
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

          {/* Passphrase */}
          <div className="space-y-2">
            <Label htmlFor="infra-passphrase">Key Passphrase (optional)</Label>
            <Input
              id="infra-passphrase"
              type="password"
              value={passPhrase}
              onChange={(e) => setPassPhrase(e.target.value)}
              placeholder="Encrypted key passphrase"
              className="h-9"
            />
          </div>

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
