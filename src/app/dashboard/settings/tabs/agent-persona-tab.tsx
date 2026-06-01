"use client";

import { GlassPanel, GlassPanelContent, GlassPanelFooter } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Bot,
  Loader2,
  CheckCircle,
  AlertCircle,
  RotateCcw,
  Lightbulb,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useState, useCallback } from "react";
import type { UserSettings } from "../types";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Be concise, direct, and write natural responses.";

const EXAMPLE_PROMPTS = [
  {
    title: "Professional & Formal",
    prompt:
      "You are a professional AI assistant. Use formal language, complete sentences, and a polished tone. Avoid slang, contractions, and casual expressions. Be thorough but concise.",
  },
  {
    title: "Friendly & Conversational",
    prompt:
      "You are a friendly and approachable AI assistant. Write in a warm, conversational tone. Use contractions naturally, keep things light, and feel free to use occasional humor. Be helpful without being overly formal.",
  },
  {
    title: "Direct & Minimal",
    prompt:
      "You are a no-nonsense AI assistant. Get straight to the point. Use short sentences, bullet points when helpful, and skip pleasantries. Focus on facts and actionable information only.",
  },
  {
    title: "Creative & Expressive",
    prompt:
      "You are a creative and expressive AI assistant. Use vivid language, varied sentence structure, and an engaging tone. Feel free to be witty and use metaphors when appropriate. Make responses interesting to read.",
  },
];

interface AgentPersonaTabProps {
  settings: UserSettings | null;
  onSettingsChange: (settings: UserSettings) => void;
  saving: boolean;
  saveStatus: "idle" | "success" | "error";
  onSave: () => Promise<void>;
}

export function AgentPersonaTab({
  settings,
  onSettingsChange,
  saving,
  saveStatus,
  onSave,
}: AgentPersonaTabProps) {
  const [expanded, setExpanded] = useState(false);
  const prompt = settings?.agentSystemPrompt ?? "";
  const isDefault = !settings?.agentSystemPrompt;

  const handleReset = useCallback(() => {
    if (settings) {
      onSettingsChange({ ...settings, agentSystemPrompt: null });
    }
  }, [settings, onSettingsChange]);

  const handleApplyExample = useCallback(
    (examplePrompt: string) => {
      if (settings) {
        onSettingsChange({ ...settings, agentSystemPrompt: examplePrompt });
      }
    },
    [settings, onSettingsChange],
  );

  return (
    <GlassPanel>
      <GlassPanelContent className="space-y-6">
        {/* Header */}
        <div>
          <h3 className="flex items-center gap-2 text-lg font-medium">
            <Bot className="h-5 w-5" />
            AI Agent Persona
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Define how your AI agent behaves in chat conversations and email reply drafts. This
            system prompt shapes the writing style, tone, and personality.
          </p>
        </div>

        <Separator />

        {/* System Prompt Editor */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="agent-system-prompt">System Prompt</Label>
            {isDefault && <span className="text-muted-foreground text-xs">Using default</span>}
          </div>

          <Textarea
            id="agent-system-prompt"
            placeholder={DEFAULT_SYSTEM_PROMPT}
            value={prompt}
            onChange={(e) => {
              if (settings) {
                onSettingsChange({
                  ...settings,
                  agentSystemPrompt: e.target.value || null,
                });
              }
            }}
            className="min-h-[140px] font-mono text-sm leading-relaxed"
          />

          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">
              {prompt.length} characters · Defines behavior for chat &amp; email replies
            </span>
            {!isDefault && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-7 gap-1 text-xs"
                onClick={handleReset}
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </Button>
            )}
          </div>
        </div>

        <Separator />

        {/* Example Prompts */}
        <div className="space-y-3">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-sm font-medium"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <Lightbulb className="text-muted-foreground h-4 w-4" />
            Example Prompts
          </button>

          {expanded && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {EXAMPLE_PROMPTS.map((example) => (
                <div
                  key={example.title}
                  className="border-border/50 bg-background/40 rounded-xl border p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium">{example.title}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => handleApplyExample(example.prompt)}
                    >
                      Apply
                    </Button>
                  </div>
                  <p className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
                    {example.prompt}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </GlassPanelContent>

      {/* Footer with save */}
      <GlassPanelFooter>
        <div>
          {saveStatus === "success" && (
            <span className="flex items-center gap-1 text-sm text-emerald-500">
              <CheckCircle className="h-4 w-4" />
              Saved
            </span>
          )}
          {saveStatus === "error" && (
            <span className="flex items-center gap-1 text-sm text-red-500">
              <AlertCircle className="h-4 w-4" />
              Failed to save
            </span>
          )}
          {saveStatus === "idle" && (
            <span className="text-muted-foreground text-sm">Changes are applied when you save</span>
          )}
        </div>
        <Button onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {saving ? "Saving" : "Save"}
        </Button>
      </GlassPanelFooter>
    </GlassPanel>
  );
}
