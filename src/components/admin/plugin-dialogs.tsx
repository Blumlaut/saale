"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, PackagePlus } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteJson, postJson } from "@/lib/http";
import type { PluginInfo, PluginListResult, PluginLogEntry } from "@/lib/pi/plugins";

export interface PluginResponse extends PluginListResult {
  log: PluginLogEntry[];
}

export interface PluginInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The fresh plugin list, after the package landed. */
  onInstalled: (response: PluginResponse, installed: PluginInfo) => void;
}

/**
 * Install a plugin from npm.
 *
 * `npm install` runs in the plugin directory, so the package is loaded by
 * every session from then on. The wait is real: the dialog stays open with a
 * spinner until npm is done.
 */
export function PluginInstallDialog({ open, onOpenChange, onInstalled }: PluginInstallDialogProps) {
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setSpec("");
    setError(null);
  };

  const submit = async () => {
    const value = spec.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await postJson<PluginResponse & { installed: PluginInfo }>(
        "/api/admin/plugins/install",
        { spec: value },
      );
      onInstalled(response, response.installed);
      reset();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to install a plugin:", err);
      setError(err instanceof Error ? err.message : "Could not install the package");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install a plugin</DialogTitle>
          <DialogDescription>Installs an npm package into the plugin directory.</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Label htmlFor="plugin-spec">Package</Label>
          <Input
            id="plugin-spec"
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
            placeholder="npm:@narumitw/pi-usage"
            className="font-mono"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
          <p className="text-muted-foreground text-xs">
            A name, a scope, or a pinned version. Pi loads it from{" "}
            <span className="font-mono">pi.extensions</span>.
          </p>
          <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            The package runs with the server&apos;s permissions.
          </p>
          {error && <p className="text-destructive text-xs break-words">{error}</p>}
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || spec.trim().length === 0}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PackagePlus className="h-4 w-4" />
            )}
            {busy ? "Installing…" : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface PluginUninstallDialogProps {
  /** The plugin to remove; `null` closes the dialog. */
  plugin: PluginInfo | null;
  onOpenChange: (open: boolean) => void;
  onRemoved: (response: PluginResponse) => void;
}

/** Confirm removing an npm-installed plugin. Reinstall it from npm to get it back. */
export function PluginUninstallDialog({
  plugin,
  onOpenChange,
  onRemoved,
}: PluginUninstallDialogProps) {
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!plugin || busy) return;
    setBusy(true);
    try {
      const response = await deleteJson<PluginResponse>("/api/admin/plugins/install", {
        id: plugin.id,
      });
      onRemoved(response);
    } catch (err) {
      console.error("Failed to uninstall a plugin:", err);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={plugin !== null}
      title={`Uninstall ${plugin?.name ?? "this plugin"}?`}
      description="npm removes it from the plugin directory, so it stops loading in every session."
      confirmLabel="Uninstall"
      busyLabel="Uninstalling…"
      onOpenChange={onOpenChange}
      onConfirm={remove}
    />
  );
}
