"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { InstallSkillInput } from "@/hooks/use-skills";
import type { SkillView } from "@/lib/skills/shared";

/**
 * Add a skill from an address serving its `SKILL.md`, or from the file pasted
 * here. The address is read first, so the text field only applies without one.
 */
export function SkillAddDialog({
  open,
  onOpenChange,
  onInstall,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (input: InstallSkillInput) => Promise<SkillView>;
}) {
  const [url, setUrl] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (installing) return;
    if (!next) {
      setUrl("");
      setMarkdown("");
      setError(null);
    }
    onOpenChange(next);
  };

  const canInstall = url.trim().length > 0 || markdown.trim().length > 0;

  const install = async () => {
    if (!canInstall) return;
    setInstalling(true);
    setError(null);
    try {
      await onInstall(url.trim() ? { url: url.trim() } : { markdown });
      setUrl("");
      setMarkdown("");
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message || "Failed to install the skill");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a skill</DialogTitle>
          <DialogDescription>
            Skills follow the Agent Skills format: a short frontmatter with a name and a
            description, then the instructions.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="skill-url">Address of a SKILL.md</Label>
            <Input
              id="skill-url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              placeholder="https://example.com/skills/pdf-tools/SKILL.md"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-markdown">Or its contents</Label>
            <Textarea
              id="skill-markdown"
              value={markdown}
              onChange={(event) => {
                setMarkdown(event.target.value);
                setError(null);
              }}
              placeholder={
                "---\nname: pdf-tools\ndescription: Extract text from PDFs. Use when reading a PDF.\n---\n\nOpen the file with…"
              }
              spellCheck={false}
              className="h-40 resize-none font-mono text-xs"
            />
            <p className="text-muted-foreground text-xs">Used when no address is given.</p>
          </div>

          {error && (
            <p className="text-destructive flex items-start gap-2 text-xs">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={install} disabled={installing || !canInstall}>
            {installing ? <Spinner className="mr-2" label="Installing" /> : null}
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
