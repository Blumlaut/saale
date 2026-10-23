"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { postJson } from "@/lib/http";

/** The name a clone URL suggests, so the field is not empty when it can be filled. */
function suggestedName(url: string): string {
  const last = url
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .split(/[/:]/)
    .filter(Boolean)
    .pop();
  return (last ?? "").replace(/\.git$/i, "");
}

/**
 * Create a project: an empty repo, or a clone.
 *
 * The clone fields stay hidden until the user asks for a clone, so the common
 * case (start from nothing) is one field and one button.
 */
export function ProjectCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [authFromEnv, setAuthFromEnv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setCloneUrl("");
    setAuthFromEnv(false);
    setError(null);
  };

  const submit = async () => {
    const trimmedName = name.trim() || suggestedName(cloneUrl);
    if (!trimmedName && !cloneUrl.trim()) {
      setError("Give the project a name.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const body = await postJson<{ project: { id: string; name: string } }>(
        "/api/coder/projects",
        {
          ...(trimmedName ? { name: trimmedName } : {}),
          ...(cloneUrl.trim() ? { cloneUrl: cloneUrl.trim(), authFromEnv } : {}),
        },
      );
      reset();
      onOpenChange(false);
      onCreated(body.project);
    } catch (err) {
      console.error("Failed to create a coder project:", err);
      setError(err instanceof Error ? err.message : "Could not create the project.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A git repo in your workspace. Leave the clone URL empty to start an empty one.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-2">
            <Label htmlFor="coder-project-name">Name</Label>
            <Input
              id="coder-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="saale-web"
              autoComplete="off"
            />
          </div>

          <div className="grid grid-cols-1 gap-2">
            <Label htmlFor="coder-project-clone">Clone URL</Label>
            <Input
              id="coder-project-clone"
              value={cloneUrl}
              onChange={(event) => setCloneUrl(event.target.value)}
              placeholder="https://github.com/owner/repo.git"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs break-all">
              Public repos clone without a token. Private ones need a GH_TOKEN variable under
              Settings → Integrations.
            </p>
          </div>

          {cloneUrl.trim() && (
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="coder-project-auth">Use GH_TOKEN</Label>
              <Switch
                id="coder-project-auth"
                checked={authFromEnv}
                onCheckedChange={setAuthFromEnv}
              />
            </div>
          )}

          {error && <p className="text-destructive text-sm break-words">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
