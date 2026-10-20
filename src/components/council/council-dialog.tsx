"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelPicker } from "@/components/shared/model-picker";
import { ThinkingSelector } from "@/components/chat/thinking-selector";
import { deleteJson, patchJson, postJson } from "@/lib/http";
import { TOOL_CATEGORIES } from "@/lib/pi/tool-categories";
import { DEFAULT_THINKING_LEVEL_SETTING } from "@/lib/pi/thinking-levels";
import {
  COUNCIL_DEFAULT_TOOL_CONFIG,
  COUNCIL_ORCHESTRATIONS,
  DEFAULT_RUN_BUDGET,
  MAX_BRIEF_LENGTH,
  MAX_COUNCIL_NAME_LENGTH,
  MAX_MEMBERS,
  MIN_MEMBERS,
  STOP_VOTE_THRESHOLDS,
  type CouncilOrchestration,
  type StopVoteThreshold,
} from "@/lib/council/config";
import type { CouncilDetail, CouncilMemberView } from "@/types/council";
import { Loader2, Plus, Trash2, Users } from "lucide-react";

export interface CouncilDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present for an edit; absent for a create. */
  council?: CouncilDetail | null;
  onSaved?: () => void;
}

interface MemberDraft {
  key: string;
  /** Set for a member that already exists on the server. */
  id?: string;
  name: string;
  /** "provider/modelId". the model picker's value format. */
  modelValue: string;
  thinkingLevel: string;
  instructions: string;
  enabled: boolean;
}

let draftCounter = 0;
function nextKey(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

/** Whether a category is on for a brand-new council (the workspace, and only it). */
function defaultToolEnabled(key: string): boolean {
  return (COUNCIL_DEFAULT_TOOL_CONFIG as Record<string, boolean>)[key] ?? false;
}

function draftFromMember(member: CouncilMemberView): MemberDraft {
  const modelValue =
    member.modelProvider && member.modelName ? `${member.modelProvider}/${member.modelName}` : "";
  const draft: MemberDraft = {
    key: nextKey(),
    id: member.id,
    name: member.name,
    modelValue,
    thinkingLevel: member.thinkingLevel || DEFAULT_THINKING_LEVEL_SETTING,
    instructions: member.instructions ?? "",
    enabled: member.enabled,
  };
  return draft;
}

function blankDraft(): MemberDraft {
  return {
    key: nextKey(),
    name: "",
    modelValue: "",
    thinkingLevel: DEFAULT_THINKING_LEVEL_SETTING,
    instructions: "",
    enabled: true,
  };
}

/** Split a model picker value into the provider/name pair the council stores. */
function splitModel(value: string): { modelProvider?: string; modelName?: string } {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return { modelName: trimmed };
  return { modelProvider: trimmed.slice(0, slash), modelName: trimmed.slice(slash + 1) };
}

/** A budget field: blank inherits, 0 is unlimited. `null` for an untouched edit. */
function parseBudget(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function budgetText(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * Create or edit a council.
 *
 * A council's tool defaults are its own workspace and nothing else: only the
 * terminal (the council's isolated workspace) is on, and every category that
 * reaches the owner's own data is off until deliberately switched on here.
 */
export function CouncilDialog({ open, onOpenChange, council, onSaved }: CouncilDialogProps) {
  const isEdit = Boolean(council);

  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [orchestration, setOrchestration] = useState<CouncilOrchestration>("parallel");
  const [stopVoteThreshold, setStopVoteThreshold] = useState<StopVoteThreshold>("majority");
  const [maxDurationSeconds, setMaxDurationSeconds] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [maxCostUsd, setMaxCostUsd] = useState("");
  const [toolConfig, setToolConfig] = useState<Record<string, boolean>>({});
  const [members, setMembers] = useState<MemberDraft[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // (Re)build the form whenever the dialog opens, so a cancelled edit does not
  // leak into the next opening.
  useEffect(() => {
    if (!open) return;
    if (council) {
      setName(council.name);
      setBrief(council.brief);
      setOrchestration(council.orchestration);
      setStopVoteThreshold(council.stopVoteThreshold);
      setMaxDurationSeconds(budgetText(council.maxDurationSeconds));
      setMaxTokens(budgetText(council.maxTokens));
      setMaxCostUsd(budgetText(council.maxCostUsd));
      setMembers(council.members.map(draftFromMember));
      setToolConfig(
        Object.fromEntries(
          TOOL_CATEGORIES.map((category) => [
            category.key,
            council.toolConfig[category.key] ?? defaultToolEnabled(category.key),
          ]),
        ),
      );
    } else {
      setName("");
      setBrief("");
      setOrchestration("parallel");
      setStopVoteThreshold("majority");
      setMaxDurationSeconds("");
      setMaxTokens("");
      setMaxCostUsd("");
      setMembers([blankDraft(), blankDraft()]);
      setToolConfig({ ...COUNCIL_DEFAULT_TOOL_CONFIG });
    }
    setError("");
  }, [open, council]);

  const updateMember = (key: string, patch: Partial<MemberDraft>) => {
    setMembers((prev) => prev.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };

  const removeMember = (key: string) => {
    setMembers((prev) => prev.filter((draft) => draft.key !== key));
  };

  const addMember = () => {
    setMembers((prev) => (prev.length >= MAX_MEMBERS ? prev : [...prev, blankDraft()]));
  };

  const toggleTool = (key: string) => {
    setToolConfig((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  /** The council-level body shared by create and edit. */
  const councilBody = () => ({
    name: name.trim(),
    brief: brief.trim(),
    orchestration,
    stopVoteThreshold,
    // Explicit booleans, because the stored config is an override on top of
    // COUNCIL_DEFAULT_TOOL_CONFIG. an omitted key would silently fall back.
    toolConfig: Object.fromEntries(TOOL_CATEGORIES.map((c) => [c.key, toolConfig[c.key] ?? false])),
    maxDurationSeconds: parseBudget(maxDurationSeconds) ?? null,
    maxTokens: parseBudget(maxTokens) ?? null,
    maxCostUsd: parseBudget(maxCostUsd) ?? null,
  });

  const memberBody = (draft: MemberDraft) => {
    const split = splitModel(draft.modelValue);
    return {
      name: draft.name.trim(),
      instructions: draft.instructions.trim() || null,
      modelProvider: split.modelProvider ?? null,
      modelName: split.modelName ?? null,
      thinkingLevel: draft.thinkingLevel,
      enabled: draft.enabled,
    };
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    const trimmedBrief = brief.trim();
    if (!trimmedName) {
      setError("Give the council a name.");
      return;
    }
    if (!trimmedBrief) {
      setError("Describe the goal the council should work on.");
      return;
    }
    if (members.length < MIN_MEMBERS) {
      setError(`A council needs at least ${MIN_MEMBERS} members.`);
      return;
    }
    if (members.length > MAX_MEMBERS) {
      setError(`A council has at most ${MAX_MEMBERS} members.`);
      return;
    }

    setLoading(true);
    setError("");
    try {
      if (!council) {
        await postJson("/api/council", {
          ...councilBody(),
          members: members.map(memberBody),
        });
      } else {
        await patchJson(`/api/council/${council.id}`, councilBody());

        const keptIds = new Set(members.map((draft) => draft.id).filter(Boolean));
        const removed = council.members.filter((member) => !keptIds.has(member.id));

        await Promise.all([
          ...removed.map((member) => deleteJson(`/api/council/${council.id}/members/${member.id}`)),
          ...members
            .filter((draft): draft is MemberDraft & { id: string } => Boolean(draft.id))
            .map((draft) =>
              patchJson(`/api/council/${council.id}/members/${draft.id}`, memberBody(draft)),
            ),
          ...members
            .filter((draft) => !draft.id)
            .map((draft) => postJson(`/api/council/${council.id}/members`, memberBody(draft))),
        ]);
      }

      onOpenChange(false);
      onSaved?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save the council";
      console.error("Failed to save a council:", err);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const terminalDescription =
    "The council's own isolated workspace: a dedicated container account, separate from your home directory. Commands and files here do not touch your own.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            {isEdit ? "Edit council" : "New council"}
          </DialogTitle>
          <DialogDescription>
            A room of named agents that collaborate on a goal. Members speak only through the
            council_post tool, so every room message is deliberate.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <div className="space-y-1.5">
            <Label htmlFor="council-name">Name</Label>
            <Input
              id="council-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Launch review board"
              maxLength={MAX_COUNCIL_NAME_LENGTH}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="council-brief">Brief</Label>
            <Textarea
              id="council-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="The goal, the constraints and what a good outcome looks like."
              rows={3}
              maxLength={MAX_BRIEF_LENGTH}
            />
            <p className="text-muted-foreground text-xs">
              Every member is given the brief as its standing context.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Orchestration</Label>
              <Select
                value={orchestration}
                onValueChange={(value) =>
                  setOrchestration((value as CouncilOrchestration) ?? "parallel")
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COUNCIL_ORCHESTRATIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {COUNCIL_ORCHESTRATIONS.find((o) => o.value === orchestration)?.description}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Stop vote</Label>
              <Select
                value={stopVoteThreshold}
                onValueChange={(value) =>
                  setStopVoteThreshold((value as StopVoteThreshold) ?? "majority")
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STOP_VOTE_THRESHOLDS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {STOP_VOTE_THRESHOLDS.find((o) => o.value === stopVoteThreshold)?.description}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <Label>Default run budget</Label>
              <p className="text-muted-foreground text-xs">
                Blank inherits the built-in default ({DEFAULT_RUN_BUDGET.maxDurationSeconds}s,{" "}
                {DEFAULT_RUN_BUDGET.maxTokens} tokens, ${DEFAULT_RUN_BUDGET.maxCostUsd}). 0 means
                unlimited.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="council-seconds" className="text-xs">
                  Time (seconds)
                </Label>
                <Input
                  id="council-seconds"
                  inputMode="numeric"
                  value={maxDurationSeconds}
                  onChange={(e) => setMaxDurationSeconds(e.target.value)}
                  placeholder={String(DEFAULT_RUN_BUDGET.maxDurationSeconds)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="council-tokens" className="text-xs">
                  Tokens
                </Label>
                <Input
                  id="council-tokens"
                  inputMode="numeric"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  placeholder={String(DEFAULT_RUN_BUDGET.maxTokens)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="council-cost" className="text-xs">
                  Cost (USD)
                </Label>
                <Input
                  id="council-cost"
                  inputMode="decimal"
                  value={maxCostUsd}
                  onChange={(e) => setMaxCostUsd(e.target.value)}
                  placeholder={String(DEFAULT_RUN_BUDGET.maxCostUsd)}
                />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label>Members</Label>
                <p className="text-muted-foreground text-xs">
                  {members.length} of {MAX_MEMBERS}. Names are the handles members address each
                  other by.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addMember}
                disabled={members.length >= MAX_MEMBERS}
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </div>

            <div className="flex flex-col gap-3">
              {members.map((draft) => (
                <div key={draft.key} className="liquid-glass-inner rounded-xl border-0 p-3">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Label htmlFor={`member-name-${draft.key}`} className="text-xs">
                        Name
                      </Label>
                      <Input
                        id={`member-name-${draft.key}`}
                        value={draft.name}
                        onChange={(e) => updateMember(draft.key, { name: e.target.value })}
                        placeholder="Leave blank to assign a random name"
                      />
                    </div>
                    <div className="flex shrink-0 flex-col items-center gap-1 pt-4">
                      <Switch
                        checked={draft.enabled}
                        onCheckedChange={(checked) => updateMember(draft.key, { enabled: checked })}
                        aria-label={`Enable ${draft.name || "member"}`}
                      />
                      <span className="text-muted-foreground text-[10px]">
                        {draft.enabled ? "on" : "off"}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeMember(draft.key)}
                      aria-label="Remove member"
                      className="text-destructive mt-4 shrink-0"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Model</Label>
                      <div className="border-border flex h-9 items-center rounded-lg border px-2">
                        <ModelPicker
                          value={draft.modelValue}
                          onChange={(value) => updateMember(draft.key, { modelValue: value })}
                          placeholder="Default model"
                          compact
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Thinking</Label>
                      <div className="border-border flex h-9 items-center rounded-lg border px-2">
                        <ThinkingSelector
                          value={draft.thinkingLevel}
                          onChange={(value) => updateMember(draft.key, { thinkingLevel: value })}
                          modelProvider={splitModel(draft.modelValue).modelProvider}
                          modelName={splitModel(draft.modelValue).modelName}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 space-y-1.5">
                    <Label htmlFor={`member-instructions-${draft.key}`} className="text-xs">
                      Instructions
                    </Label>
                    <Textarea
                      id={`member-instructions-${draft.key}`}
                      value={draft.instructions}
                      onChange={(e) => updateMember(draft.key, { instructions: e.target.value })}
                      placeholder="What this member is responsible for."
                      rows={2}
                      className="min-h-[60px]"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <Label>Tools</Label>
              <p className="text-muted-foreground text-xs">
                Only the council&apos;s own workspace is on by default. Categories that reach your
                own data. Email, Telegram, Tasks, Calendar, Memory, Infrastructure, Settings, Agent
                jobs and Watchers. stay off until you switch them on for this council.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TOOL_CATEGORIES.map((category) => {
                const Icon = category.icon;
                const checked = toolConfig[category.key] ?? false;
                const description =
                  category.key === "terminal" ? terminalDescription : category.description;
                return (
                  <div
                    key={category.key}
                    className="hover:bg-muted/50 flex items-start gap-3 rounded-lg border p-3"
                  >
                    <Icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{category.label}</span>
                        {category.key === "terminal" && (
                          <Badge variant="secondary" className="text-[10px]">
                            isolated
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
                    </div>
                    <Switch
                      checked={checked}
                      onCheckedChange={() => toggleTool(category.key)}
                      aria-label={`Enable ${category.label} for this council`}
                      className="mt-0.5 shrink-0"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEdit ? "Save changes" : "Create council"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
