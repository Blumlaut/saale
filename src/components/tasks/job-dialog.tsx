"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Mail, Tags, Shield, RefreshCw } from "lucide-react";

interface JobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

const jobTemplates = [
  {
    type: "email_sync",
    label: "Email Sync",
    icon: RefreshCw,
    description: "Sync emails from connected accounts",
    defaultConfig: { cronExpression: "*/30 * * * *" },
  },
  {
    type: "summarization",
    label: "Email Summarization",
    icon: Mail,
    description: "Auto-summarize new emails with AI",
    defaultConfig: { cronExpression: "0 */6 * * *", limit: 10 },
  },
  {
    type: "classification",
    label: "Classification + Tags",
    icon: Tags,
    description: "Auto-tag incoming emails with AI",
    defaultConfig: { cronExpression: "0 */6 * * *", limit: 10 },
  },
  {
    type: "spam_filtering",
    label: "Spam Filtering",
    icon: Shield,
    description: "Evaluate spam score for new emails",
    defaultConfig: { cronExpression: "0 */4 * * *", limit: 20, spamThreshold: 0.8 },
  },
];

export function JobDialog({ open, onOpenChange, onSuccess }: JobDialogProps) {
  const [selectedType, setSelectedType] = useState("");
  const [cronExpression, setCronExpression] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [extraConfig, setExtraConfig] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async () => {
    if (!selectedType) return;

    setLoading(true);
    setError("");

    try {
      let config: Record<string, unknown> = { cronExpression };

      // Parse extra config
      if (extraConfig.trim()) {
        try {
          config = { ...config, ...JSON.parse(extraConfig) };
        } catch {
          setError("Invalid JSON in extra config");
          setLoading(false);
          return;
        }
      }

      // Add default config for type
      const template = jobTemplates.find((t) => t.type === selectedType);
      if (template) {
        config = { ...template.defaultConfig, ...config };
      }

      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedType,
          enabled,
          config,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create job");
      }

      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setSelectedType("");
    setCronExpression("");
    setEnabled(true);
    setExtraConfig("");
    setError("");
  };

  const handleTypeChange = (type: string) => {
    setSelectedType(type);
    const template = jobTemplates.find((t) => t.type === type);
    if (template) {
      setCronExpression(template.defaultConfig.cronExpression ?? "");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) resetForm();
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Job</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Template selection */}
          <div className="grid gap-2 sm:grid-cols-2">
            {jobTemplates.map((template) => {
              const Icon = template.icon;
              return (
                <button
                  key={template.type}
                  onClick={() => handleTypeChange(template.type)}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors hover:bg-white/20 dark:hover:bg-white/5",
                    selectedType === template.type && "border-primary bg-white/20 dark:bg-white/5",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="text-sm font-medium">{template.label}</span>
                  <span className="text-muted-foreground text-xs">{template.description}</span>
                </button>
              );
            })}
          </div>

          <Separator />

          {/* Schedule */}
          <div className="space-y-2">
            <Label>Cron Schedule</Label>
            <Input
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              placeholder="*/30 * * * *"
            />
            <p className="text-muted-foreground text-xs">
              Examples: <code>* * * * *</code> (every minute), <code>*/30 * * * *</code> (every 30
              min), <code>0 9 * * *</code> (daily at 9am)
            </p>
          </div>

          {/* Extra config */}
          <div className="space-y-2">
            <Label>Extra Config (JSON, optional)</Label>
            <Textarea
              value={extraConfig}
              onChange={(e) => setExtraConfig(e.target.value)}
              placeholder='{"accountId": "...", "limit": 10}'
              className="font-mono text-sm"
            />
          </div>

          {/* Enabled */}
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id="job-enabled" />
            <Label htmlFor="job-enabled">Enabled</Label>
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive bg-destructive/10 rounded-lg px-3 py-2 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={loading || !selectedType}>
              {loading ? "Creating..." : "Create Job"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { cn } from "@/lib/utils";
