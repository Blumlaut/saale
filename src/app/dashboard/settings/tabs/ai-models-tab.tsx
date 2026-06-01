"use client";

import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Bot, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import type { UserSettings, AvailableModel, AvailableProvider } from "../types";

interface AiModelsTabProps {
  settings: UserSettings | null;
  onSettingsChange: (settings: UserSettings) => void;
  availableModels: Record<string, AvailableModel[]>;
  availableModelProviders: AvailableProvider[];
  saving: boolean;
  saveStatus: "idle" | "success" | "error";
  onSave: () => Promise<void>;
}

export function AiModelsTab({
  settings,
  onSettingsChange,
  availableModels,
  availableModelProviders,
  saving,
  saveStatus,
  onSave,
}: AiModelsTabProps) {
  return (
    <GlassPanel>
      <GlassPanelContent className="space-y-6">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-medium">
            <Bot className="h-5 w-5" />
            Default Model
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Choose the default model for new chat sessions.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="model-provider">Provider</Label>
            <Select
              value={settings?.defaultModelProvider ?? ""}
              onValueChange={(v) => {
                if (v && settings) {
                  onSettingsChange({ ...settings, defaultModelProvider: v });
                }
              }}
            >
              <SelectTrigger id="model-provider">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {availableModelProviders.length === 0 && (
                  <SelectItem value="none" disabled>
                    Add an API key first
                  </SelectItem>
                )}
                {availableModelProviders.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.modelCount} models)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="model-name">Model</Label>
            <Select
              value={settings?.defaultModelName ?? ""}
              onValueChange={(v) => {
                if (v && settings) {
                  onSettingsChange({ ...settings, defaultModelName: v });
                }
              }}
            >
              <SelectTrigger id="model-name">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {(() => {
                  const providerModels = settings?.defaultModelProvider
                    ? availableModels[settings.defaultModelProvider]
                    : undefined;
                  if (!providerModels) {
                    return (
                      <SelectItem value="none" disabled>
                        {settings?.defaultModelProvider
                          ? "No models available"
                          : "Select a provider first"}
                      </SelectItem>
                    );
                  }
                  return providerModels
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                        {m.reasoning ? " ✦" : ""}
                      </SelectItem>
                    ));
                })()}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="thinking-level">Thinking Level</Label>
          <Select
            value={settings?.defaultThinkingLevel ?? "off"}
            onValueChange={(v) => {
              if (v && settings) {
                onSettingsChange({ ...settings, defaultThinkingLevel: v });
              }
            }}
          >
            <SelectTrigger id="thinking-level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="minimal">Minimal</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="xhigh">X-High</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={onSave} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle className="mr-2 h-4 w-4" />
            )}
            Save
          </Button>
          {saveStatus === "success" && (
            <span className="flex items-center gap-1 text-sm text-emerald-500">
              <CheckCircle className="h-4 w-4" />
              Saved
            </span>
          )}
          {saveStatus === "error" && (
            <span className="flex items-center gap-1 text-sm text-red-500">
              <AlertCircle className="h-4 w-4" />
              Failed
            </span>
          )}
        </div>
      </GlassPanelContent>
    </GlassPanel>
  );
}
