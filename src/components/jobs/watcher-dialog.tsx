"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchJson, patchJson, postJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { formatModelReference, splitModelReference } from "@/lib/pi/model-ref";
import { ModelPicker } from "@/components/shared/model-picker";
import { Loader2, Play, Radar } from "lucide-react";
import type { ScriptWatcher } from "@/types/shared";

/** The part of a conversation the target picker needs. */
interface ChatOption {
  id: string;
  title: string;
}

/** The part of a project the target picker needs. */
interface ProjectOption {
  id: string;
  name: string;
  slug: string;
}

interface WatcherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  watcher?: ScriptWatcher | null;
}

/** No conversation selected. only a delivery that does not need one may leave it out. */
const NO_TARGET = "none";

/** Where a fire goes, as the dialog offers it. */
const DELIVERY_OPTIONS = [
  { value: "chat", label: "A conversation" },
  { value: "silent", label: "Nothing (the script delivers it)" },
  { value: "coder", label: "A project's coder chat" },
];

const WORKTREE_MODE_OPTIONS = [
  { value: "per-fire", label: "A fresh worktree every fire" },
  { value: "sticky", label: "One chat and worktree for the whole thread" },
];

const CRON_PRESETS = [
  { value: "*/5 * * * *", label: "Every 5 minutes" },
  { value: "*/10 * * * *", label: "Every 10 minutes" },
  { value: "*/30 * * * *", label: "Every 30 minutes" },
  { value: "0 * * * *", label: "Every hour" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "0 9 * * *", label: "Daily at 9am" },
];

const STARTER_SCRIPT = `const seen = load('seen') ?? [];
const mails = await tools.mail_list({ folder: 'INBOX', limit: 20 });

const fresh = mails.filter((m) => !seen.includes(m.uid));
store('seen', [...seen, ...fresh.map((m) => m.uid)].slice(-200));

// Returning nothing means "no news". nobody is woken.
if (fresh.length === 0) return undefined;
return { count: fresh.length, subjects: fresh.map((m) => m.subject) };`;

/** The result of one test run, shown under the script. */
interface TestResult {
  status: string;
  value?: unknown;
  reason?: string;
  output: string;
  durationMs: number;
  callCount: number;
}

/**
 * Create or edit a watcher.
 *
 * A watcher runs unattended, so the dialog is where the script is read and tried
 * before it is put on a schedule.
 */
export function WatcherDialog({ open, onOpenChange, onSuccess, watcher }: WatcherDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [script, setScript] = useState("");
  const [cronExpression, setCronExpression] = useState("*/10 * * * *");
  const [deliver, setDeliver] = useState("chat");
  const [sessionId, setSessionId] = useState<string>(NO_TARGET);
  const [projectId, setProjectId] = useState<string>(NO_TARGET);
  const [worktreeMode, setWorktreeMode] = useState("per-fire");
  const [retentionMinutes, setRetentionMinutes] = useState("1440");
  // Canonical `provider:model`; empty means the user's default model.
  const [modelId, setModelId] = useState("");
  const [wakePrompt, setWakePrompt] = useState("");
  const [cooldownMinutes, setCooldownMinutes] = useState("0");
  const [enabled, setEnabled] = useState(true);

  const [chats, setChats] = useState<ChatOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = Boolean(watcher);

  // Load the conversations and projects a watcher can report into, once per open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const [chatData, projectData] = await Promise.all([
          fetchJson<{ sessions: ChatOption[] }>("/api/chat/sessions"),
          fetchJson<{ projects: ProjectOption[] }>("/api/coder/projects"),
        ]);
        if (cancelled) return;
        setChats(chatData.sessions ?? []);
        setProjects(projectData.projects ?? []);
      } catch (err) {
        console.error("Failed to load watcher delivery targets:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Seed the form from the watcher being edited, or a starter script for a new one.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTestResult(null);

    if (watcher) {
      setName(watcher.name);
      setDescription(watcher.description ?? "");
      setScript(watcher.script);
      setCronExpression(watcher.cronExpression);
      setDeliver(watcher.deliver);
      setSessionId(watcher.sessionId ?? NO_TARGET);
      setProjectId(watcher.projectId ?? NO_TARGET);
      setWorktreeMode(watcher.worktreeMode);
      setRetentionMinutes(String(watcher.retentionMinutes));
      setModelId(watcher.modelId ?? "");
      setWakePrompt(watcher.wakePrompt);
      setCooldownMinutes(String(watcher.cooldownMinutes));
      setEnabled(watcher.enabled);
    } else {
      setName("");
      setDescription("");
      setScript(STARTER_SCRIPT);
      setCronExpression("*/10 * * * *");
      setDeliver("chat");
      setSessionId(NO_TARGET);
      setProjectId(NO_TARGET);
      setWorktreeMode("per-fire");
      setRetentionMinutes("1440");
      setModelId("");
      setWakePrompt("");
      setCooldownMinutes("0");
      setEnabled(true);
    }
  }, [open, watcher]);

  const resolveTarget = useCallback(
    () => (sessionId === NO_TARGET ? null : sessionId),
    [sessionId],
  );

  const resolveProject = useCallback(
    () => (projectId === NO_TARGET ? null : projectId),
    [projectId],
  );

  // The picker speaks `provider/modelId`; the watcher stores `provider:modelId`.
  const pickerValue = useMemo(() => {
    const reference = splitModelReference(modelId);
    return reference ? `${reference.provider}/${reference.name}` : "";
  }, [modelId]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const data = await postJson<{ outcome: TestResult }>("/api/watchers", {
        preview: true,
        script,
        sessionId: resolveTarget(),
      });
      setTestResult(data.outcome);
    } catch (err) {
      console.error("Failed to test the watcher script:", err);
      setError(err instanceof Error ? err.message : "The script could not be run.");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name,
        description,
        script,
        cronExpression,
        deliver,
        sessionId: resolveTarget(),
        projectId: resolveProject(),
        worktreeMode,
        retentionMinutes: Number(retentionMinutes) || 0,
        modelId: modelId || null,
        wakePrompt,
        cooldownMinutes: Number(cooldownMinutes) || 0,
        enabled,
      };

      if (watcher) {
        await patchJson(`/api/watchers/${watcher.id}`, payload);
      } else {
        await postJson("/api/watchers", payload);
      }

      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save watcher:", err);
      setError(err instanceof Error ? err.message : "Failed to save the watcher.");
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    name.trim().length > 0 &&
    script.trim().length > 0 &&
    cronExpression.trim().length > 0 &&
    (deliver !== "chat" || sessionId !== NO_TARGET) &&
    (deliver !== "coder" || projectId !== NO_TARGET);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radar className="h-4 w-4" />
            {isEdit ? "Edit watcher" : "New watcher"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="grid grid-cols-1 gap-2">
              <Label htmlFor="watcher-name">Name</Label>
              <Input
                id="watcher-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Watch the inbox"
              />
            </div>

            <div className="grid grid-cols-1 gap-2">
              <Label htmlFor="watcher-cron">Check every</Label>
              <Input
                id="watcher-cron"
                value={cronExpression}
                onChange={(event) => setCronExpression(event.target.value)}
                placeholder="*/10 * * * *"
                className="font-mono"
              />
              <div className="flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((preset) => (
                  <Button
                    key={preset.value}
                    type="button"
                    variant={cronExpression === preset.value ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setCronExpression(preset.value)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2">
            <Label htmlFor="watcher-deliver">Where should this go?</Label>
            <Select value={deliver} onValueChange={(value) => setDeliver(value ?? "chat")}>
              <SelectTrigger id="watcher-deliver">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIVERY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {deliver === "chat" && (
              <>
                <Select
                  value={sessionId}
                  onValueChange={(value) => setSessionId(value ?? NO_TARGET)}
                >
                  <SelectTrigger aria-label="Conversation to answer in">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TARGET}>Pick a conversation</SelectItem>
                    {chats.map((chat) => (
                      <SelectItem key={chat.id} value={chat.id}>
                        {chat.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  When the script reports something, the agent is given it here and answers in this
                  conversation, with the conversation&apos;s own tools and history.
                </p>
              </>
            )}

            {deliver === "silent" && (
              <p className="text-muted-foreground text-xs">
                Nothing is woken, and no tokens are spent. The script tells you itself. Send the
                message from inside it with <code>await tools.telegram_send({"{ message }"})</code>,
                and return the item you sent as a note in the log. Returning it does not message you
                again.
              </p>
            )}

            {deliver === "coder" && (
              <>
                <Select
                  value={projectId}
                  onValueChange={(value) => setProjectId(value ?? NO_TARGET)}
                >
                  <SelectTrigger aria-label="Project to dispatch into">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TARGET}>Pick a project</SelectItem>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Each fire opens a coder chat in this project and works in its own worktree, so it
                  never touches a checkout you are working in.
                </p>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="grid grid-cols-1 gap-2">
                    <Label htmlFor="watcher-worktree">Worktree</Label>
                    <Select
                      value={worktreeMode}
                      onValueChange={(value) => setWorktreeMode(value ?? "per-fire")}
                    >
                      <SelectTrigger id="watcher-worktree">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WORKTREE_MODE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-xs">
                      {worktreeMode === "sticky"
                        ? "Every fire continues in the same chat, so a thread can pick up where the last one stopped."
                        : "Every fire gets its own chat and branch, so two runs can never collide."}
                    </p>
                  </div>

                  <div className="grid grid-cols-1 gap-2">
                    <Label htmlFor="watcher-retention">Keep finished chats (minutes)</Label>
                    <Input
                      id="watcher-retention"
                      type="number"
                      min={0}
                      value={retentionMinutes}
                      onChange={(event) => setRetentionMinutes(event.target.value)}
                    />
                    <p className="text-muted-foreground text-xs">
                      A per-fire chat is removed once this has passed, and only when its branch is
                      pushed and its tree is clean. Anything with work in it stays.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2">
                  <Label>Model for the chat it opens</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <ModelPicker
                      value={pickerValue}
                      onChange={(value) => {
                        const reference = splitModelReference(value);
                        setModelId(
                          reference
                            ? (formatModelReference(reference.provider, reference.name) ?? "")
                            : "",
                        );
                      }}
                      placeholder="Your default model"
                      className="rounded border"
                    />
                    {modelId && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setModelId("")}
                      >
                        Use the default
                      </Button>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Left alone, the chat uses whichever model you have as your default.
                  </p>
                </div>
              </>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2">
            <Label htmlFor="watcher-description">Description (optional)</Label>
            <Input
              id="watcher-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this watcher is for"
            />
          </div>

          <div className="grid grid-cols-1 gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="watcher-script">Script</Label>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void handleTest()}
                disabled={testing || !script.trim()}
              >
                {testing ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                )}
                Test run
              </Button>
            </div>
            <Textarea
              id="watcher-script"
              value={script}
              onChange={(event) => setScript(event.target.value)}
              rows={12}
              spellCheck={false}
              className="max-h-80 min-h-40 overflow-auto font-mono text-xs whitespace-pre"
            />
            <p className="text-muted-foreground text-xs">
              Runs on a schedule and costs no tokens. Return <code>undefined</code> when there is
              nothing to report. that is the common case. Keep state between checks with{" "}
              <code>store()</code> and <code>load()</code>.
            </p>
          </div>

          {testResult && (
            <div className="bg-muted/40 rounded border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium">
                  Test run · {testResult.status}
                  {testResult.callCount > 0 && ` · ${testResult.callCount} tool call(s)`}
                </span>
                <span className="text-muted-foreground font-mono text-xs">
                  {testResult.durationMs}ms
                </span>
              </div>
              {testResult.reason && (
                <p className="text-destructive mt-1.5 text-xs break-words whitespace-pre-wrap">
                  {testResult.reason}
                </p>
              )}
              {testResult.value !== undefined && testResult.value !== null && (
                <pre className="bg-background mt-2 max-h-40 overflow-auto rounded p-2 font-mono text-xs break-all whitespace-pre-wrap">
                  {JSON.stringify(testResult.value, null, 2)}
                </pre>
              )}
              {testResult.output && (
                <pre className="text-muted-foreground mt-2 max-h-40 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
                  {testResult.output}
                </pre>
              )}
              {testResult.status === "idle" && (
                <p className="text-muted-foreground mt-1.5 text-xs">
                  The script returned nothing, so this check would be quiet.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="grid grid-cols-1 gap-2">
              <Label htmlFor="watcher-cooldown">Cooldown (minutes)</Label>
              <Input
                id="watcher-cooldown"
                type="number"
                min={0}
                value={cooldownMinutes}
                onChange={(event) => setCooldownMinutes(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Shortest gap between two wakes. 0 lets every report through.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <Label htmlFor="watcher-enabled">Enabled</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch id="watcher-enabled" checked={enabled} onCheckedChange={setEnabled} />
                <span className="text-muted-foreground text-xs">
                  {enabled ? "Checks on schedule" : "Paused"}
                </span>
              </div>
            </div>
          </div>

          {deliver !== "silent" && (
            <div className="grid grid-cols-1 gap-2">
              <Label htmlFor="watcher-wake">When it fires, tell the agent to…</Label>
              <Textarea
                id="watcher-wake"
                value={wakePrompt}
                onChange={(event) => setWakePrompt(event.target.value)}
                rows={3}
                placeholder="Review what changed and tell me briefly what it means."
              />
              <p className="text-muted-foreground text-xs">
                The script&apos;s returned value is included automatically.
              </p>
            </div>
          )}

          {watcher?.lastTickAt && (
            <p className="text-muted-foreground text-xs">
              Last checked {formatRelativeDate(watcher.lastTickAt)}
              {watcher.lastFiredAt
                ? `, last delivered ${formatRelativeDate(watcher.lastFiredAt)}`
                : ", nothing delivered yet"}
              .
            </p>
          )}

          {error && (
            <p className="text-destructive text-sm break-words whitespace-pre-wrap">{error}</p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || !canSave}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {isEdit ? "Save" : "Create watcher"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
