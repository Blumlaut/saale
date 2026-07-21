"use client";

import { useState, useEffect } from "react";
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
import { postJson, patchJson } from "@/lib/http";
import { Bot, Loader2 } from "lucide-react";
import type { AgentJobDefinition } from "@/types/shared";
import { TOOL_CATEGORIES } from "@/lib/pi/tool-categories";

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

const THINKING_LEVELS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export function AgentJobDialog({ open, onOpenChange, onSuccess, job }: AgentJobDialogProps) {
  const isEditMode = !!job;

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const [outputChannel, setOutputChannel] = useState("");
  const [outputChannelId, setOutputChannelId] = useState("");
  const [cronExpression, setCronExpression] = useState("");
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
    setCronExpression("");
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
      setThinkingLevel(job.thinkingLevel ?? "off");
      setOutputChannel(job.outputChannel ?? "");
      setOutputChannelId(job.outputChannelId ?? "");
      setCronExpression(job.cronExpression ?? "");
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

  const handleSubmit = async () => {
    if (!name.trim() || !prompt.trim()) {
      setError("Name and prompt are required");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim(),
        systemPrompt: systemPrompt.trim() || undefined,
        toolConfig: Object.keys(toolConfig).length > 0 ? toolConfig : undefined,
        modelId: modelId.trim() || undefined,
        thinkingLevel: thinkingLevel || undefined,
        outputChannel: outputChannel || undefined,
        outputChannelId: outputChannelId.trim() || undefined,
        cronExpression: cronExpression.trim() || undefined,
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
          <div className="grid gap-4 md:grid-cols-2">
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
              <Select value={thinkingLevel} onValueChange={(v) => setThinkingLevel(v ?? "off")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THINKING_LEVELS.map((level) => (
                    <SelectItem key={level.value} value={level.value}>
                      {level.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Output Routing */}
          <div className="grid gap-4 md:grid-cols-2">
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
                <Label htmlFor="agent-channel-id">Channel ID</Label>
                <Input
                  id="agent-channel-id"
                  value={outputChannelId}
                  onChange={(e) => setOutputChannelId(e.target.value)}
                  placeholder={outputChannel === "telegram" ? "Telegram chat ID" : "Channel ID"}
                />
              </div>
            )}
          </div>

          {/* Schedule */}
          <div className="space-y-2">
            <Label htmlFor="agent-cron">
              Cron Schedule <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="agent-cron"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              placeholder="0 9 * * *"
            />
            <p className="text-muted-foreground text-xs">
              Examples: <code className="bg-muted/50 rounded px-1">0 9 * * *</code> (daily at 9am),{" "}
              <code className="bg-muted/50 rounded px-1">0 */6 * * *</code> (every 6 hours)
            </p>
          </div>

          {/* Tool Access */}
          <div className="space-y-3">
            <Label>Tool Access</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {TOOL_CATEGORIES.map((category) => {
                const Icon = category.icon;
                const isChecked = toolConfig[category.key] ?? category.defaultEnabled;
                return (
                  <div
                    key={category.key}
                    className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-white/5"
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
