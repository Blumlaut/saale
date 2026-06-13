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

const CHAT_EXAMPLE_INSTRUCTIONS = [
  {
    title: "Always Use Code Blocks",
    instruction:
      "Always wrap code snippets in fenced code blocks with language tags. Never inline code without formatting.",
  },
  {
    title: "Explain Your Reasoning",
    instruction:
      "Before giving an answer, briefly explain your reasoning or approach. Show your work step by step for complex questions.",
  },
  {
    title: "Ultra-Concise",
    instruction:
      "Keep responses under 3 sentences unless the user asks for detail. Skip all pleasantries and introductions — start directly with the answer.",
  },
  {
    title: "Teach Don't Just Answer",
    instruction:
      "When answering, explain the underlying concepts so the user learns. Use analogies when helpful. Assume the user is curious but not an expert.",
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
  examples: { title: string; prompt?: string; instruction?: string }[];
  exampleLabel: string;
  fieldKey: "instruction" | "prompt";
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
  fieldKey,
}: PromptSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const isEmpty = !value || value.trim() === "";

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
          {isEmpty && <span className="text-muted-foreground text-xs">Using defaults</span>}
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
          {!isEmpty && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 gap-1 text-xs"
              onClick={() => onChange(null)}
            >
              <RotateCcw className="h-3 w-3" />
              Clear
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
            {examples.map((example) => {
              const text = fieldKey === "instruction" ? example.instruction : example.prompt;
              return (
                <div key={example.title} className="liquid-glass-inner rounded-xl border-0 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs font-medium">{example.title}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-5 px-1.5 text-[10px]"
                      onClick={() => onChange(text ?? null)}
                    >
                      Apply
                    </Button>
                  </div>
                  <p className="text-muted-foreground line-clamp-3 text-[11px] leading-relaxed">
                    {text}
                  </p>
                </div>
              );
            })}
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
  const handleCustomInstructionsChange = useCallback(
    (value: string | null) => {
      if (settings) {
        onSettingsChange({ ...settings, agentCustomInstructions: value });
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

        {/* Chat Custom Instructions Section */}
        <PromptSection
          title="Chat — Custom Instructions"
          description="These instructions are appended to Saale's default behavior. Use them to add specific rules, preferences, or formatting guidelines."
          icon={MessageSquare}
          label="Custom Instructions"
          placeholder="e.g. Always respond in German. / Prefer bullet points. / Never use markdown headings..."
          value={settings?.agentCustomInstructions ?? ""}
          onChange={handleCustomInstructionsChange}
          examples={CHAT_EXAMPLE_INSTRUCTIONS}
          exampleLabel="Example Instructions"
          fieldKey="instruction"
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
          fieldKey="prompt"
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
