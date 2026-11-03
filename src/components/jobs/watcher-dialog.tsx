"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson, patchJson, postJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { formatModelReference, splitModelReference } from "@/lib/pi/model-ref";
import { getCronLabel } from "@/lib/jobs/cron-label";
import { THINKING_LEVEL_OPTIONS } from "@/lib/pi/thinking-levels";
import { broadcastWatchersChanged } from "@/lib/chat/session-events";
import { ModelPicker } from "@/components/shared/model-picker";
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

/** No conversation or project selected. */
const NO_SELECTION = "none";

/** Where a fire goes, as the dialog offers it. */
const DELIVERY_OPTIONS = [
  { value: "chat", label: "A conversation" },
  { value: "none", label: "A run of its own" },
  { value: "silent", label: "The script sends it" },
  { value: "coder", label: "A project's coder chat" },
];

const WORKTREE_MODE_OPTIONS = [
  { value: "per-fire", label: "A fresh worktree every fire" },
  { value: "sticky", label: "One chat and worktree for the whole thread" },
];

const THINKING_OPTIONS = THINKING_LEVEL_OPTIONS.map((option) => ({
  value: option.id,
  label: option.label,
}));

const STARTER_SCRIPT = `const seen = load('seen') ?? [];
const mails = await tools.mail_list({ folder: 'INBOX', limit: 20 });

const fresh = mails.filter((m) => !seen.includes(m.uid));
store('seen', [...seen, ...fresh.map((m) => m.uid)].slice(-200));

// Returning nothing means "no news". nobody is woken.
if (fresh.length === 0) return undefined;
return { count: fresh.length, subjects: fresh.map((m) => m.subject) };`;

/** What a test run says it would do, in words. */
const TEST_STATUS_LABELS: Record<string, string> = {
  fired: "Would report",
  idle: "Nothing to report",
  error: "Failed",
};

/** The result of one test run, shown under the script. */
interface TestResult {
  status: string;
  value?: unknown;
  reason?: string;
  output: string;
  durationMs: number;
  callCount: number;
}

/** One titled group of fields. */
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="console-label text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A label, its control, and the line that explains it. */
function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

/** A setting that is on or off, with its label on the left. */
function SwitchRow({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>
      </div>
      <Switch id={id} className="mt-0.5" checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/**
 * Create or edit an automation.
 *
 * An automation runs unattended, so the sheet is where the script is read and
 * tried before it is put on a schedule. With no script it fires on every tick,
 * which is what a plain scheduled prompt is.
 */
export function WatcherDialog({ open, onOpenChange, onSuccess, watcher }: WatcherDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [script, setScript] = useState("");
  const [cronExpression, setCronExpression] = useState("*/10 * * * *");
  const [maxFires, setMaxFires] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("default");
  const [deliver, setDeliver] = useState("chat");
  const [sessionId, setSessionId] = useState<string>(NO_SELECTION);
  const [projectId, setProjectId] = useState<string>(NO_SELECTION);
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
        console.error("Failed to load automation delivery targets:", err);
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
      setScript(watcher.script ?? "");
      setCronExpression(watcher.cronExpression ?? "");
      setDeliver(watcher.deliver);
      setSessionId(watcher.sessionId ?? NO_SELECTION);
      setProjectId(watcher.projectId ?? NO_SELECTION);
      setWorktreeMode(watcher.worktreeMode);
      setRetentionMinutes(String(watcher.retentionMinutes));
      setModelId(watcher.modelId ?? "");
      setWakePrompt(watcher.wakePrompt);
      setCooldownMinutes(String(watcher.cooldownMinutes));
      setMaxFires(watcher.maxFires == null ? "" : String(watcher.maxFires));
      setThinkingLevel(watcher.thinkingLevel);
      setEnabled(watcher.enabled);
    } else {
      setName("");
      setDescription("");
      setScript("");
      setCronExpression("*/10 * * * *");
      setDeliver("chat");
      setSessionId(NO_SELECTION);
      setProjectId(NO_SELECTION);
      setWorktreeMode("per-fire");
      setRetentionMinutes("1440");
      setModelId("");
      setWakePrompt("");
      setCooldownMinutes("0");
      setMaxFires("");
      setThinkingLevel("default");
      setEnabled(true);
    }
  }, [open, watcher]);

  const resolveTarget = useCallback(
    () => (sessionId === NO_SELECTION ? null : sessionId),
    [sessionId],
  );

  const resolveProject = useCallback(
    () => (projectId === NO_SELECTION ? null : projectId),
    [projectId],
  );

  // The picker speaks `provider/modelId`; the watcher stores `provider:modelId`.
  const pickerValue = useMemo(() => {
    const reference = splitModelReference(modelId);
    return reference ? `${reference.provider}/${reference.name}` : "";
  }, [modelId]);

  const handleModelChange = useCallback((value: string) => {
    const reference = splitModelReference(value);
    setModelId(reference ? (formatModelReference(reference.provider, reference.name) ?? "") : "");
  }, []);

  const chatItems = useMemo(
    () => [
      { value: NO_SELECTION, label: "Pick a conversation" },
      ...chats.map((chat) => ({ value: chat.id, label: chat.title })),
    ],
    [chats],
  );

  const projectItems = useMemo(
    () => [
      { value: NO_SELECTION, label: "Pick a project" },
      ...projects.map((project) => ({ value: project.id, label: project.name })),
    ],
    [projects],
  );

  const cronLabel = cronExpression.trim() ? getCronLabel(cronExpression.trim()) : "";

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const data = await postJson<{ outcome: TestResult }>("/api/automations", {
        preview: true,
        script,
        sessionId: resolveTarget(),
      });
      setTestResult(data.outcome);
    } catch (err) {
      console.error("Failed to test the automation script:", err);
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
        script: script.trim() ? script : null,
        cronExpression: cronExpression.trim() || null,
        deliver,
        sessionId: resolveTarget(),
        projectId: resolveProject(),
        worktreeMode,
        retentionMinutes: Number(retentionMinutes) || 0,
        modelId: modelId || null,
        wakePrompt,
        cooldownMinutes: Number(cooldownMinutes) || 0,
        maxFires: maxFires.trim() ? Number(maxFires) : null,
        thinkingLevel,
        enabled,
      };

      if (watcher) {
        await patchJson(`/api/automations/${watcher.id}`, payload);
      } else {
        await postJson("/api/automations", payload);
      }

      // The chat lists mark the conversations a watcher rides along with.
      broadcastWatchersChanged();
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save automation:", err);
      setError(err instanceof Error ? err.message : "Failed to save the automation.");
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    name.trim().length > 0 &&
    (deliver !== "chat" || sessionId !== NO_SELECTION) &&
    (deliver !== "coder" || projectId !== NO_SELECTION);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[560px] sm:max-w-none">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b px-4 pt-4 pb-3 md:px-6">
            <SheetTitle className="pr-8">
              {isEdit ? "Edit automation" : "New automation"}
            </SheetTitle>
            <SheetDescription className="text-xs">
              A script on a schedule. It costs no tokens until it has something to report.
            </SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4 md:px-6">
            <Section title="Basics">
              <Field label="Name" htmlFor="watcher-name">
                <Input
                  id="watcher-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Watch the inbox"
                  maxLength={120}
                />
              </Field>
              <Field label="Description" htmlFor="watcher-description">
                <Input
                  id="watcher-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What this watcher is for"
                  maxLength={200}
                />
              </Field>
            </Section>

            <Section title="Schedule">
              <Field
                label="Run every"
                htmlFor="watcher-cron"
                hint={
                  !cronExpression.trim()
                    ? "Empty means it only runs when you ask for a test run."
                    : cronLabel === cronExpression.trim()
                      ? "A five-field cron expression."
                      : `${cronLabel}.`
                }
              >
                <Input
                  id="watcher-cron"
                  value={cronExpression}
                  onChange={(event) => setCronExpression(event.target.value)}
                  placeholder="*/10 * * * *"
                  className="font-mono"
                />
              </Field>

              <SwitchRow
                id="watcher-enabled"
                label="Enabled"
                hint={enabled ? "Runs on this schedule." : "Paused until you turn it back on."}
                checked={enabled}
                onCheckedChange={setEnabled}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Cooldown (minutes)"
                  htmlFor="watcher-cooldown"
                  hint="Shortest gap between two reports. 0 lets every one through."
                >
                  <Input
                    id="watcher-cooldown"
                    type="number"
                    min={0}
                    value={cooldownMinutes}
                    onChange={(event) => setCooldownMinutes(event.target.value)}
                  />
                </Field>

                <Field
                  label="Stop after (fires)"
                  htmlFor="watcher-max-fires"
                  hint="1 makes it a one-off. Empty keeps it running."
                >
                  <Input
                    id="watcher-max-fires"
                    type="number"
                    min={1}
                    value={maxFires}
                    onChange={(event) => setMaxFires(event.target.value)}
                    placeholder="No limit"
                  />
                </Field>
              </div>
            </Section>

            <Section
              title="Script"
              action={
                <div className="flex items-center gap-1">
                  {!script.trim() && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setScript(STARTER_SCRIPT)}
                    >
                      <Sparkles />
                      Starter script
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleTest()}
                    disabled={testing || !script.trim()}
                  >
                    {testing ? <Loader2 className="animate-spin" /> : <Play />}
                    Test run
                  </Button>
                </div>
              }
            >
              <Textarea
                id="watcher-script"
                aria-label="Automation script"
                value={script}
                onChange={(event) => setScript(event.target.value)}
                rows={10}
                spellCheck={false}
                placeholder="// Return something to report it."
                className="max-h-96 min-h-44 font-mono text-xs whitespace-pre"
              />
              <p className="text-muted-foreground text-xs">
                Runs on the schedule and costs no tokens. Return <code>undefined</code> when there
                is nothing to report, which is the usual answer. Keep state between checks with{" "}
                <code>store()</code> and <code>load()</code>. Leave it empty and every tick wakes
                the agent.
              </p>

              {testResult && (
                <div className="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium">
                      {TEST_STATUS_LABELS[testResult.status] ?? testResult.status}
                      {testResult.callCount > 0 && ` · ${testResult.callCount} tool calls`}
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {testResult.durationMs} ms
                    </span>
                  </div>
                  {testResult.reason && (
                    <p className="text-destructive text-xs break-words whitespace-pre-wrap">
                      {testResult.reason}
                    </p>
                  )}
                  {testResult.value !== undefined && testResult.value !== null && (
                    <pre className="bg-background max-h-40 overflow-auto rounded-md border p-2 font-mono text-xs break-all whitespace-pre-wrap">
                      {JSON.stringify(testResult.value, null, 2)}
                    </pre>
                  )}
                  {testResult.output && (
                    <pre className="text-muted-foreground max-h-40 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
                      {testResult.output}
                    </pre>
                  )}
                </div>
              )}
            </Section>

            <Section title="Delivery">
              <Field label="Where it goes" htmlFor="watcher-deliver">
                <Select
                  items={DELIVERY_OPTIONS}
                  value={deliver}
                  onValueChange={(value) => setDeliver(value ?? "chat")}
                >
                  <SelectTrigger id="watcher-deliver" className="w-full">
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
              </Field>

              {deliver === "chat" && (
                <Field
                  label="Conversation"
                  hint="The agent answers there, with that conversation's tools and history."
                >
                  <Select
                    items={chatItems}
                    value={sessionId}
                    onValueChange={(value) => setSessionId(value ?? NO_SELECTION)}
                  >
                    <SelectTrigger aria-label="Conversation to answer in" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {chatItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}

              {deliver === "none" && (
                <>
                  <p className="text-muted-foreground text-xs">
                    The agent runs on its own, with your tools and no conversation. Anything you
                    hear about has to come from those tools, for example{" "}
                    <code>await tools.telegram_send({"{ message }"})</code>.
                  </p>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Model" hint="Empty uses your default model.">
                      <ModelPicker
                        value={pickerValue}
                        onChange={handleModelChange}
                        placeholder="Your default model"
                        triggerClassName="w-full"
                        className="border-input h-9 w-full justify-between rounded-lg border px-2.5"
                      />
                    </Field>
                    <Field label="Thinking" htmlFor="watcher-thinking">
                      <Select
                        items={THINKING_OPTIONS}
                        value={thinkingLevel}
                        onValueChange={(value) => setThinkingLevel(value ?? "default")}
                      >
                        <SelectTrigger id="watcher-thinking" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {THINKING_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </>
              )}

              {deliver === "silent" && (
                <p className="text-muted-foreground text-xs">
                  Nothing is woken and no tokens are spent. The script sends the message itself with{" "}
                  <code>await tools.telegram_send({"{ message }"})</code>. What it returns is kept
                  as a note in the log.
                </p>
              )}

              {deliver === "coder" && (
                <>
                  <Field
                    label="Project"
                    hint="Each fire opens a coder chat in the project and works in its own worktree."
                  >
                    <Select
                      items={projectItems}
                      value={projectId}
                      onValueChange={(value) => setProjectId(value ?? NO_SELECTION)}
                    >
                      <SelectTrigger aria-label="Project to dispatch into" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {projectItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field
                      label="Worktree"
                      htmlFor="watcher-worktree"
                      hint={
                        worktreeMode === "sticky"
                          ? "Every fire continues in the same chat."
                          : "Every fire gets its own chat and branch."
                      }
                    >
                      <Select
                        items={WORKTREE_MODE_OPTIONS}
                        value={worktreeMode}
                        onValueChange={(value) => setWorktreeMode(value ?? "per-fire")}
                      >
                        <SelectTrigger id="watcher-worktree" className="w-full">
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
                    </Field>

                    <Field
                      label="Keep finished chats (minutes)"
                      htmlFor="watcher-retention"
                      hint="A per-fire chat goes once this has passed and its branch is pushed and clean."
                    >
                      <Input
                        id="watcher-retention"
                        type="number"
                        min={0}
                        value={retentionMinutes}
                        onChange={(event) => setRetentionMinutes(event.target.value)}
                      />
                    </Field>
                  </div>

                  <Field label="Model" hint="Empty uses your default model.">
                    <div className="flex items-center gap-2">
                      <ModelPicker
                        value={pickerValue}
                        onChange={handleModelChange}
                        placeholder="Your default model"
                        triggerClassName="min-w-0 flex-1"
                        className="border-input h-9 w-full justify-between rounded-lg border px-2.5"
                      />
                      {modelId && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setModelId("")}
                        >
                          Use the default
                        </Button>
                      )}
                    </div>
                  </Field>
                </>
              )}

              {deliver !== "silent" && (
                <Field
                  label="What the agent should do"
                  htmlFor="watcher-wake"
                  hint="The script's returned value is included automatically."
                >
                  <Textarea
                    id="watcher-wake"
                    value={wakePrompt}
                    onChange={(event) => setWakePrompt(event.target.value)}
                    rows={3}
                    placeholder="Review what changed and tell me briefly what it means."
                  />
                </Field>
              )}
            </Section>

            {watcher?.lastTickAt && (
              <p className="text-muted-foreground border-t pt-3 text-xs">
                Last checked {formatRelativeDate(watcher.lastTickAt)}
                {watcher.lastFiredAt
                  ? `, last reported ${formatRelativeDate(watcher.lastFiredAt)}`
                  : ", nothing reported yet"}
                .
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t px-4 py-3 md:px-6">
            {error && (
              <p className="text-destructive text-xs break-words whitespace-pre-wrap">{error}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => void handleSave()} disabled={saving || !canSave}>
                {saving && <Loader2 className="animate-spin" />}
                {isEdit ? "Save changes" : "Create automation"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
