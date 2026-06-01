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
  MessageSquare,
  Mail,
} from "lucide-react";
import { useState, useCallback } from "react";
import type { UserSettings } from "../types";

const DEFAULT_CHAT_PROMPT =
  "You are a helpful AI assistant. Be concise, direct, and write natural responses.";

const CHAT_EXAMPLE_PROMPTS = [
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

const EMAIL_EXAMPLE_STYLES = [
  {
    title: "Professional",
    prompt:
      "Write emails in a professional and courteous tone. Use complete sentences and proper business etiquette. Keep responses clear and well-structured. Sign off naturally based on the context.",
  },
  {
    title: "Casual & Friendly",
    prompt:
      "Write emails like a real person would — natural, warm, and conversational. Use contractions, keep things brief, and don't over-formalize. Match the sender's energy.",
  },
  {
    title: "Short & Direct",
    prompt:
      "Keep emails short and to the point. No fluff, no unnecessary pleasantries. Answer questions directly and get to the action item fast. Use bullet points when listing things.",
  },
  {
    title: "Warm & Thoughtful",
    prompt:
      "Write emails that feel personal and thoughtful. Show genuine interest, acknowledge the other person's perspective, and keep a warm but professional tone. Make every email feel like it was written with care.",
  },
];

interface PromptSectionProps {
  title: string;
  description: string;
  icon: typeof MessageSquare;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string | null) => void;
  examples: { title: string; prompt: string }[];
  exampleLabel: string;
}

function PromptSection({
  title,
  description,
  icon: Icon,
  label,
  placeholder,
  value,
  onChange,
  examples,
  exampleLabel,
}: PromptSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const isDefault = !value;

  return (
    <div className="space-y-4">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <Icon className="text-muted-foreground h-4 w-4" />
        <h4 className="text-sm font-medium">{title}</h4>
      </div>
      <p className="text-muted-foreground text-xs">{description}</p>

      {/* Editor */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor={label}>{label}</Label>
          {isDefault && <span className="text-muted-foreground text-xs">Using default</span>}
        </div>

        <Textarea
          id={label}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value || null)}
          className="min-h-[120px] font-mono text-sm leading-relaxed"
        />

        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs">{value.length} characters</span>
          {!isDefault && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 gap-1 text-xs"
              onClick={() => onChange(null)}
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          )}
        </div>
      </div>

      {/* Examples */}
      <div className="space-y-2">
        <button
          type="button"
          className="flex w-full items-center gap-2 text-xs font-medium"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <Lightbulb className="text-muted-foreground h-3 w-3" />
          {exampleLabel}
        </button>

        {expanded && (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {examples.map((example) => (
              <div
                key={example.title}
                className="border-border/50 bg-background/40 rounded-xl border p-2.5"
              >
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-medium">{example.title}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() => onChange(example.prompt)}
                  >
                    Apply
                  </Button>
                </div>
                <p className="text-muted-foreground line-clamp-3 text-[11px] leading-relaxed">
                  {example.prompt}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

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
  const handleChatPromptChange = useCallback(
    (value: string | null) => {
      if (settings) {
        onSettingsChange({ ...settings, agentSystemPrompt: value });
      }
    },
    [settings, onSettingsChange],
  );

  const handleEmailStyleChange = useCallback(
    (value: string | null) => {
      if (settings) {
        onSettingsChange({ ...settings, emailWritingStyle: value });
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
            Customize how your AI agent behaves in chat and how it writes email replies on your
            behalf.
          </p>
        </div>

        <Separator />

        {/* Chat Persona Section */}
        <PromptSection
          title="Chat Persona"
          description="Defines the personality and behavior of your AI assistant in chat conversations."
          icon={MessageSquare}
          label="Chat System Prompt"
          placeholder={DEFAULT_CHAT_PROMPT}
          value={settings?.agentSystemPrompt ?? ""}
          onChange={handleChatPromptChange}
          examples={CHAT_EXAMPLE_PROMPTS}
          exampleLabel="Example Personas"
        />

        <Separator />

        {/* Email Writing Style Section */}
        <PromptSection
          title="Email Writing Style"
          description="Defines how your AI drafts email replies so they sound like you. This is separate from the chat persona."
          icon={Mail}
          label="Email Writing Style"
          placeholder="Write emails in a natural, conversational tone. Keep things brief and friendly..."
          value={settings?.emailWritingStyle ?? ""}
          onChange={handleEmailStyleChange}
          examples={EMAIL_EXAMPLE_STYLES}
          exampleLabel="Example Styles"
        />
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
