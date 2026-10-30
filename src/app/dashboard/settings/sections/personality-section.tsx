"use client";

import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { PageAction, PageActions } from "@/components/layout/page";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Bot,
  Check,
  RotateCcw,
  Lightbulb,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Mail,
  Terminal,
} from "lucide-react";
import { AutosaveStatus, type SaveState } from "../components/save-state";
import { useUserSettings } from "../components/user-settings-provider";
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
      "Keep responses under 3 sentences unless asked for detail. Start directly with the answer.",
  },
  {
    title: "Teach Don't Just Answer",
    instruction:
      "When answering, explain the underlying concepts so the user learns. Use analogies when helpful. Assume the user is curious but not an expert.",
  },
];

const CODER_EXAMPLE_INSTRUCTIONS = [
  {
    title: "Explain Before Rewriting",
    instruction:
      "Never rewrite a file before saying what is wrong with it. Name the failing behaviour, the code that causes it, then make the smallest change that fixes it.",
  },
  {
    title: "Ask Before Adding Dependencies",
    instruction:
      "Never add a dependency without asking first. Solve it with what the project already has, or propose the package and wait for a yes.",
  },
  {
    title: "Small, Reviewable Commits",
    instruction:
      "One commit per behaviour change, never a mixed commit. If a change touches more than three files, split it or explain why it cannot be split.",
  },
  {
    title: "Match the Existing Code",
    instruction:
      "Match the surrounding code before inventing a pattern: read a neighbouring file and follow its naming, structure and comment density instead of your own defaults.",
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
    prompt: "Write emails like a real person: warm, brief, and natural.",
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
          className="min-h-[120px] text-sm leading-relaxed"
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
                <div key={example.title} className="bg-muted rounded-xl border-0 p-2.5">
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

/** The three prompts this page edits, lifted out of the settings row. */
interface Draft {
  agentCustomInstructions: string | null;
  coderCustomInstructions: string | null;
  emailWritingStyle: string | null;
}

function storedDraft(settings: UserSettings | null): Draft | null {
  if (!settings) return null;
  return {
    agentCustomInstructions: settings.agentCustomInstructions,
    coderCustomInstructions: settings.coderCustomInstructions,
    emailWritingStyle: settings.emailWritingStyle,
  };
}

/**
 * Settings → Personality. The one settings page that keeps a draft: an
 * instruction prompt is a paragraph someone writes, not a switch, so the page
 * has a Save button of its own in a row that stays in view.
 */
export function PersonalitySection() {
  const { settings, saving, saveState, save: saveSettings } = useUserSettings();
  // The shell holds the settings load, so the page opens on what is stored.
  const [draft, setDraft] = useState<Draft | null>(() => storedDraft(settings));

  const stored = storedDraft(settings);
  const dirty =
    !!draft &&
    !!stored &&
    (draft.agentCustomInstructions !== stored.agentCustomInstructions ||
      draft.coderCustomInstructions !== stored.coderCustomInstructions ||
      draft.emailWritingStyle !== stored.emailWritingStyle);

  const change = useCallback((value: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...value } : current));
  }, []);

  const save = async () => {
    if (!draft) return;
    await saveSettings(draft);
  };

  // At rest the row says nothing: the prompts on screen are the saved ones.
  const state: SaveState | null = saving
    ? "saving"
    : saveState === "error"
      ? "error"
      : dirty
        ? "dirty"
        : saveState === "saved"
          ? "saved"
          : null;

  return (
    <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
      <PageActions leading={state ? <AutosaveStatus state={state} /> : null}>
        <PageAction
          icon={Check}
          label="Save"
          busy={saving}
          labelOnMobile
          disabled={!dirty}
          onClick={save}
        />
      </PageActions>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <GlassPanelContent className="space-y-6">
          {/* Header */}
          <div>
            <h3 className="flex items-center gap-2 text-lg font-medium">
              <Bot className="h-5 w-5" />
              AI Agent Persona
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Customize how your AI agent behaves in chat, in coding sessions, and how it writes
              email replies on your behalf.
            </p>
          </div>

          <Separator />

          <PromptSection
            title="Custom chat instructions"
            description="These instructions are appended to Saale's default behavior. Use them to add specific rules, preferences, or formatting guidelines."
            icon={MessageSquare}
            label="Custom Instructions"
            placeholder="e.g. Always respond in German. / Prefer bullet points. / Never use markdown headings..."
            value={draft?.agentCustomInstructions ?? ""}
            onChange={(value) => change({ agentCustomInstructions: value })}
            examples={CHAT_EXAMPLE_INSTRUCTIONS}
            exampleLabel="Example Instructions"
            fieldKey="instruction"
          />

          <Separator />

          <PromptSection
            title="Coder instructions"
            description="Used by coder chats only, in place of the custom chat instructions above. Coder chats also read each project's AGENTS.md and skills from the repo."
            icon={Terminal}
            label="Coder Instructions"
            placeholder="e.g. Never add a dependency without asking. / One commit per behaviour change. / Match the surrounding code style..."
            value={draft?.coderCustomInstructions ?? ""}
            onChange={(value) => change({ coderCustomInstructions: value })}
            examples={CODER_EXAMPLE_INSTRUCTIONS}
            exampleLabel="Example Instructions"
            fieldKey="instruction"
          />

          <Separator />

          <PromptSection
            title="Email Writing Style"
            description="Defines how your AI drafts email replies so they sound like you. This is separate from the chat persona."
            icon={Mail}
            label="Email Writing Style"
            placeholder="Write emails in a natural, conversational tone. Keep things brief and friendly..."
            value={draft?.emailWritingStyle ?? ""}
            onChange={(value) => change({ emailWritingStyle: value })}
            examples={EMAIL_EXAMPLE_STYLES}
            exampleLabel="Example Styles"
            fieldKey="prompt"
          />
        </GlassPanelContent>
      </div>
    </GlassPanel>
  );
}
