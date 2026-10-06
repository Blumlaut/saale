"use client";

import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { postJson, patchJson, fetchJson } from "@/lib/http";
import { Bot, Loader2 } from "lucide-react";
import type { AgentJobDefinition } from "@/types/shared";
import { TOOL_CATEGORIES } from "@/lib/pi/tool-categories";
import {
  DEFAULT_THINKING_LEVEL_SETTING,
  THINKING_LEVEL_OPTIONS,
  normalizeThinkingLevelSetting,
} from "@/lib/pi/thinking-levels";
import type { TelegramChatInfo } from "@/lib/telegram/chats";

interface AgentJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  job?: AgentJobDefinition | null;
}

const OUTPUT_CHANNELS = [
  { value: "telegram", label: "Telegram" },
  { value: "discord", label: "Discord" },
];

/** Select sentinel: inherit the user's configured Telegram chat (no explicit ID). */
const TELEGRAM_AUTO = "auto";
/** Select sentinel: show the manual chat ID input. */
const TELEGRAM_MANUAL = "manual";

type ScheduleMode = "none" | "cron" | "once";

/** Format an ISO timestamp as a local `datetime-local` input value. */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parse a local `datetime-local` input value into an ISO timestamp. */
function fromLocalInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date/time");
  return date.toISOString();
}

export function AgentJobDialog({ open, onOpenChange, onSuccess, job }: AgentJobDialogProps) {
  const isEditMode = !!job;

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<string>(DEFAULT_THINKING_LEVEL_SETTING);
  const [outputChannel, setOutputChannel] = useState("");
  const [outputChannelId, setOutputChannelId] = useState("");
  // Telegram chat selection: "auto" (inherit configured chat) | "manual" | a chat ID
  const [telegramChatSelection, setTelegramChatSelection] = useState<string>(TELEGRAM_AUTO);
  const [manualChatId, setManualChatId] = useState("");
  const [telegramChats, setTelegramChats] = useState<TelegramChatInfo[]>([]);
  const [telegramDefaultChat, setTelegramDefaultChat] = useState<{
    chatId: string;
    label: string;
  } | null>(null);
  const [telegramChatsLoading, setTelegramChatsLoading] = useState(false);
  const [cronExpression, setCronExpression] = useState("");
  const [runAt, setRunAt] = useState("");
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("none");
  const [enabled, setEnabled] = useState(true);
  const [toolConfig, setToolConfig] = useState<Record<string, boolean>>({});

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const resetForm = () => {
    setName("");
    setDescription("");
    setPrompt("");
    setSystemPrompt("");
    setModelId("");
    setThinkingLevel("off");
    setOutputChannel("");
    setOutputChannelId("");
    setTelegramChatSelection(TELEGRAM_AUTO);
    setManualChatId("");
    setTelegramChats([]);
    setTelegramDefaultChat(null);
    setCronExpression("");
    setRunAt("");
    setScheduleMode("none");
    setEnabled(true);
    setToolConfig({});
    setError("");
  };

  // Pre-populate form when editing
  useEffect(() => {
    if (!open) return;
    if (job) {
      setName(job.name);
      setDescription(job.description ?? "");
      setPrompt(job.prompt);
      setSystemPrompt(job.systemPrompt ?? "");
      setModelId(job.modelId ?? "");
      setThinkingLevel(job.thinkingLevel ?? DEFAULT_THINKING_LEVEL_SETTING);
      setOutputChannel(job.outputChannel ?? "");
      setOutputChannelId(job.outputChannelId ?? "");
      // Telegram: a stored chat ID selects that chat (flipped to manual if
      // unknown after chats load); null/empty means "inherit configured chat".
      setManualChatId(job.outputChannelId ?? "");
      setTelegramChatSelection(job.outputChannelId ? job.outputChannelId : TELEGRAM_AUTO);
      setCronExpression(job.cronExpression ?? "");
      setRunAt(job.runAt ? toLocalInputValue(job.runAt) : "");
      setScheduleMode(job.runAt ? "once" : job.cronExpression ? "cron" : "none");
      setEnabled(job.enabled);
      setToolConfig(job.toolConfig ?? {});
    } else {
      resetForm();
    }
    setError("");
  }, [open, job]);

  const toggleTool = (key: string) => {
    setToolConfig((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const loadTelegramChats = useCallback(async () => {
    setTelegramChatsLoading(true);
    try {
      const data = await fetchJson<{
        chats: TelegramChatInfo[];
        defaultChat: { chatId: string; label: string } | null;
      }>("/api/integrations/telegram/chats");
      setTelegramChats(data.chats);
      setTelegramDefaultChat(data.defaultChat);
    } catch (err) {
      console.error("Failed to load Telegram chats:", err);
      setTelegramChats([]);
      setTelegramDefaultChat(null);
    } finally {
      setTelegramChatsLoading(false);
    }
  }, []);

  // Load available chats whenever Telegram is the selected output channel.
  useEffect(() => {
    if (outputChannel === "telegram") {
      loadTelegramChats();
    }
  }, [outputChannel, loadTelegramChats]);

  // A stored chat ID that no longer matches a known chat falls back to manual entry.
  useEffect(() => {
    if (telegramChatsLoading) return;
    const selection = telegramChatSelection;
    if (selection !== TELEGRAM_AUTO && selection !== TELEGRAM_MANUAL) {
      const known = telegramChats.some((chat) => chat.chatId === selection);
      if (!known) setTelegramChatSelection(TELEGRAM_MANUAL);
    }
  }, [telegramChats, telegramChatsLoading, telegramChatSelection]);

  const handleSubmit = async () => {
    if (!name.trim() || !prompt.trim()) {
      setError("Name and prompt are required");
      return;
    }

    if (
      outputChannel === "telegram" &&
      telegramChatSelection === TELEGRAM_AUTO &&
      telegramChats.length === 0 &&
      !telegramDefaultChat
    ) {
      setError(
        "No configured Telegram chat found. Message your bot on Telegram first, or choose a chat ID manually.",
      );
      return;
    }

    // Resolve the output channel ID: an explicit ID, a picked chat, or
    // nothing (Telegram inherits the configured chat at run time).
    let resolvedOutputChannelId: string | undefined;
    if (outputChannel === "telegram") {
      if (telegramChatSelection === TELEGRAM_MANUAL) {
        resolvedOutputChannelId = manualChatId.trim() || undefined;
      } else if (telegramChatSelection === TELEGRAM_AUTO) {
        resolvedOutputChannelId = undefined;
      } else {
        resolvedOutputChannelId = telegramChatSelection;
      }
    } else {
      resolvedOutputChannelId = outputChannelId.trim() || undefined;
    }

    if (scheduleMode === "once" && !runAt) {
      setError("Choose a date and time for the one-off run");
      return;
    }

    setLoading(true);
    setError("");

    // Send both schedule fields explicitly (empty clears) so switching modes
    // on an existing job actually removes the old schedule.
    let resolvedRunAt = "";
    try {
      if (scheduleMode === "once") resolvedRunAt = fromLocalInputValue(runAt);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
      return;
    }
    const resolvedCron = scheduleMode === "cron" ? cronExpression.trim() : "";

    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim(),
        systemPrompt: systemPrompt.trim() || undefined,
        toolConfig: Object.keys(toolConfig).length > 0 ? toolConfig : undefined,
        modelId: modelId.trim() || undefined,
        thinkingLevel: normalizeThinkingLevelSetting(thinkingLevel),
        outputChannel: outputChannel || undefined,
        outputChannelId: resolvedOutputChannelId,
        cronExpression: resolvedCron,
        runAt: resolvedRunAt,
        enabled,
      };

      if (isEditMode && job) {
        await patchJson(`/api/agent-jobs/definitions/${job.id}`, payload);
      } else {
        await postJson("/api/agent-jobs/definitions", payload);
      }

      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resetForm();
        onOpenChange(isOpen);
      }}
    >
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              {isEditMode ? "Edit Agent Job" : "Create Agent Job"}
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Email Summary"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="agent-description">Description</Label>
            <Input
              id="agent-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Summarizes my daily emails"
            />
          </div>

          {/* Prompt */}
          <div className="space-y-2">
            <Label htmlFor="agent-prompt">Prompt</Label>
            <Textarea
              id="agent-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Summarize my unread emails from the last 24 hours"
              rows={3}
              className="min-h-[80px]"
            />
            <p className="text-muted-foreground text-xs">
              The main instruction the agent will execute
            </p>
          </div>

          {/* System Prompt */}
          <div className="space-y-2">
            <Label htmlFor="agent-system-prompt">
              System Prompt <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="agent-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant that..."
              rows={2}
            />
          </div>

          {/* Model & Thinking */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="agent-model">Model</Label>
              <Input
                id="agent-model"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="anthropic:claude-sonnet-4"
              />
              <p className="text-muted-foreground text-xs">Leave empty to use default model</p>
            </div>

            <div className="space-y-2">
              <Label>Thinking Level</Label>
              <Select
                value={thinkingLevel}
                onValueChange={(v) => setThinkingLevel(v ?? DEFAULT_THINKING_LEVEL_SETTING)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THINKING_LEVEL_OPTIONS.map((level) => (
                    <SelectItem key={level.id} value={level.id}>
                      {level.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Output Routing */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Output Channel</Label>
              <Select value={outputChannel} onValueChange={(v) => setOutputChannel(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="None (logs only)" />
                </SelectTrigger>
                <SelectContent>
                  {OUTPUT_CHANNELS.map((channel) => (
                    <SelectItem key={channel.value} value={channel.value}>
                      {channel.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {outputChannel && (
              <div className="space-y-2">
                {outputChannel === "telegram" ? (
                  <>
                    <Label>Telegram Chat</Label>
                    <Select
                      value={telegramChatSelection}
                      onValueChange={(v) => setTelegramChatSelection(v ?? TELEGRAM_AUTO)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem
                          value={TELEGRAM_AUTO}
                          disabled={!telegramDefaultChat && telegramChats.length === 0}
                        >
                          Use configured chat
                        </SelectItem>
                        {telegramChats.map((chat) => (
                          <SelectItem key={chat.chatId} value={chat.chatId}>
                            {chat.label} ({chat.chatId})
                          </SelectItem>
                        ))}
                        <SelectItem value={TELEGRAM_MANUAL}>Enter chat ID manually…</SelectItem>
                      </SelectContent>
                    </Select>

                    {telegramChatSelection === TELEGRAM_AUTO && telegramChatsLoading && (
                      <p className="text-muted-foreground text-xs">Loading your chats…</p>
                    )}
                    {telegramChatSelection === TELEGRAM_AUTO &&
                      !telegramChatsLoading &&
                      telegramDefaultChat && (
                        <p className="text-muted-foreground text-xs">
                          Sends to {telegramDefaultChat.label} ({telegramDefaultChat.chatId})
                        </p>
                      )}
                    {telegramChatSelection === TELEGRAM_AUTO &&
                      !telegramChatsLoading &&
                      !telegramDefaultChat &&
                      telegramChats.length === 0 && (
                        <p className="text-muted-foreground text-xs">
                          No configured chat yet — message your bot on Telegram first, or enter a
                          chat ID manually.
                        </p>
                      )}

                    {telegramChatSelection === TELEGRAM_MANUAL && (
                      <Input
                        id="agent-channel-id"
                        value={manualChatId}
                        onChange={(e) => setManualChatId(e.target.value)}
                        placeholder="Telegram chat ID"
                      />
                    )}
                  </>
                ) : (
                  <>
                    <Label htmlFor="agent-channel-id">Channel ID</Label>
                    <Input
                      id="agent-channel-id"
                      value={outputChannelId}
                      onChange={(e) => setOutputChannelId(e.target.value)}
                      placeholder="Channel ID"
                    />
                  </>
                )}
              </div>
            )}
          </div>

          {/* Schedule */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="agent-schedule-mode">
                Schedule <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Select
                value={scheduleMode}
                onValueChange={(v) => setScheduleMode((v ?? "none") as ScheduleMode)}
              >
                <SelectTrigger id="agent-schedule-mode" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Manual only</SelectItem>
                  <SelectItem value="cron">Recurring (cron)</SelectItem>
                  <SelectItem value="once">Run once at…</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {scheduleMode === "cron" && (
              <div className="space-y-2">
                <Input
                  id="agent-cron"
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  placeholder="0 9 * * *"
                />
                <p className="text-muted-foreground text-xs">
                  Examples: <code className="bg-muted/50 rounded px-1">0 9 * * *</code> (daily at
                  9am), <code className="bg-muted/50 rounded px-1">0 */6 * * *</code> (every 6
                  hours)
                </p>
              </div>
            )}

            {scheduleMode === "once" && (
              <div className="space-y-2">
                <Input
                  id="agent-run-at"
                  type="datetime-local"
                  value={runAt}
                  onChange={(e) => setRunAt(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  Runs once at this local time, then clears. Use Telegram as the output channel
                  for reminders.
                </p>
              </div>
            )}
          </div>

          {/* Tool Access */}
          <div className="space-y-3">
            <Label>Tool Access</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TOOL_CATEGORIES.map((category) => {
                const Icon = category.icon;
                const isChecked = toolConfig[category.key] ?? category.defaultEnabled;
                return (
                  <div
                    key={category.key}
                    className="hover:bg-muted/50 flex items-center gap-3 rounded-lg border p-3 transition-colors"
                  >
                    <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{category.label}</div>
                      <div className="text-muted-foreground truncate text-xs">
                        {category.description}
                      </div>
                    </div>
                    <Switch
                      checked={isChecked}
                      onCheckedChange={() => toggleTool(category.key)}
                      className="shrink-0"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Enabled */}
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id="agent-enabled" />
            <Label htmlFor="agent-enabled">Enabled</Label>
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive bg-destructive/10 rounded-lg px-3 py-2 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {isEditMode ? "Saving..." : "Creating..."}
                </>
              ) : isEditMode ? (
                "Save Changes"
              ) : (
                "Create Job"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
