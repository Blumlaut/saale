"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, Loader2, Rocket, Sparkles } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { postJson } from "@/lib/http";
import { cn } from "@/lib/utils";

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

interface CreatedProject {
  id: string;
  name: string;
}

/** The three questions the flow asks before the first chat exists. */
const STEPS = ["Repo", "Chats", "Start"] as const;

/**
 * Set a project up: what the repo is, where its chats run, and what the first
 * chat should do.
 *
 * Every answer lands on the project row in one create, so a flow abandoned
 * halfway leaves nothing behind. An empty coder module opens this by itself,
 * which is the whole onboarding: no project, no chat, and the questions are
 * the only thing between the two.
 */
export function ProjectCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `prompt` is the first message, when the user wrote one. */
  onCreated: (result: { project: CreatedProject; prompt: string | null }) => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [ownWorktree, setOwnWorktree] = useState(true);
  const [branch, setBranch] = useState("");
  const [script, setScript] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep(0);
    setName("");
    setCloneUrl("");
    setOwnWorktree(true);
    setBranch("");
    setScript("");
    setPrompt("");
    setError(null);
  };

  const projectName = name.trim() || suggestedName(cloneUrl);
  const canLeaveRepoStep = Boolean(projectName || cloneUrl.trim());

  const next = () => {
    if (step === 0 && !canLeaveRepoStep) {
      setError("Give the project a name.");
      return;
    }
    setError(null);
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const submit = async () => {
    if (!canLeaveRepoStep) {
      setStep(0);
      setError("Give the project a name.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const body = await postJson<{ project: CreatedProject & { defaultBranch: string } }>(
        "/api/coder/projects",
        {
          name: projectName,
          chatMode: ownWorktree ? "worktree" : "repo",
          ...(cloneUrl.trim() ? { cloneUrl: cloneUrl.trim() } : {}),
          ...(branch.trim() ? { defaultBranch: branch.trim() } : {}),
          ...(script.trim() ? { setupScript: script } : {}),
        },
      );
      const first = prompt.trim();
      reset();
      onOpenChange(false);
      onCreated({ project: body.project, prompt: first || null });
    } catch (err) {
      console.error("Failed to create a coder project:", err);
      setError(err instanceof Error ? err.message : "Could not create the project.");
    } finally {
      setBusy(false);
    }
  };

  const last = step === STEPS.length - 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 0 ? "Set up a project" : projectName || "New project"}
          </DialogTitle>
          <DialogDescription>
            {step === 0
              ? "A project is a git repo in your workspace. Clone one, or start from nothing."
              : step === 1
                ? "Decide where the chats of this project work."
                : "Prepare the checkout, and give the first chat something to do."}
          </DialogDescription>
        </DialogHeader>

        {/* The step count, so the flow never feels longer than it is. */}
        <div className="flex items-center gap-2">
          {STEPS.map((label, index) => (
            <span key={label} className="flex flex-1 items-center gap-2">
              <span
                className={cn(
                  "console-label",
                  index === step ? "text-foreground" : "text-muted-foreground/60",
                )}
              >
                {index + 1}. {label}
              </span>
              {index < STEPS.length - 1 && <span className="bg-border h-px flex-1" />}
            </span>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4">
          {step === 0 && (
            <>
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
                  Leave it empty to start with an empty repo. For a private repo, set GH_TOKEN under
                  Settings → Integrations.
                </p>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Label htmlFor="coder-project-worktree">Own worktree per chat</Label>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Every chat gets a branch and a directory of its own, so two chats never edit the
                    same files. Turn it off and the chats share the project&apos;s checkout.
                  </p>
                </div>
                <Switch
                  id="coder-project-worktree"
                  className="mt-1"
                  checked={ownWorktree}
                  onCheckedChange={setOwnWorktree}
                />
              </div>

              <div className="grid grid-cols-1 gap-2">
                <Label htmlFor="coder-project-branch">Default branch</Label>
                <Input
                  id="coder-project-branch"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="the repo's own"
                  className="font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={200}
                />
                <p className="text-muted-foreground text-xs">
                  What a new chat&apos;s branch starts from. An empty field keeps the branch the
                  repo is cloned on.
                </p>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid grid-cols-1 gap-2">
                <Label htmlFor="coder-project-script">Setup script</Label>
                <Textarea
                  id="coder-project-script"
                  value={script}
                  onChange={(event) => setScript(event.target.value)}
                  placeholder="npm install"
                  rows={2}
                  className="font-mono text-xs"
                  spellCheck={false}
                />
                <p className="text-muted-foreground text-xs">
                  Runs once in the checkout before a chat&apos;s first command. You can add the env
                  files a checkout needs under the project settings.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-2">
                <Label htmlFor="coder-project-prompt">First prompt</Label>
                <Textarea
                  id="coder-project-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Read the repo and tell me what it does."
                  rows={3}
                />
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Sparkles className="h-3 w-3" />A chat starts with this as its first message.
                </p>
              </div>
            </>
          )}

          {error && <p className="text-destructive text-sm break-words">{error}</p>}
        </div>

        <DialogFooter>
          {step > 0 ? (
            <Button
              variant="ghost"
              onClick={() => setStep((current) => current - 1)}
              disabled={busy}
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
          )}

          {last ? (
            <Button onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              {prompt.trim() ? "Create and start" : "Create project"}
            </Button>
          ) : (
            <Button onClick={next} disabled={busy}>
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
