"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchSelect } from "@/components/ui/search-select";
import { Switch } from "@/components/ui/switch";
import { PageSection } from "@/components/layout/page";
import { fetchJson } from "@/lib/http";
import { VOICE_LANGUAGES } from "@/lib/voice/languages";
import type { VoiceModel } from "@/lib/voice/models";
import { DEFAULT_VOICE_MODEL } from "@/lib/voice/options";
import { SettingsRow } from "./settings-rows";
import { AdminSettingsFrame } from "./settings-frame";
import { useAdminSettings } from "./use-admin-settings";

/** The one value the language picker uses for "let the server decide". */
const DETECT_LANGUAGE = "auto";

/** The model pick that means "whatever the environment sets". */
const MODEL_FROM_ENVIRONMENT = "environment";

type ModelsState =
  | { status: "loading" }
  | { status: "ready"; models: VoiceModel[] }
  | { status: "error"; message: string };

/** Whether voice input is offered, and which model and language decode it. */
export function VoiceSection() {
  const { settings, loading, saving, saveStatus, save } = useAdminSettings();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [models, setModels] = useState<ModelsState>({ status: "loading" });

  const loadModels = useCallback(() => {
    setModels({ status: "loading" });
    fetchJson<{ models: VoiceModel[] }>("/api/admin/voice/models")
      .then((data) => setModels({ status: "ready", models: data.models }))
      .catch((err: unknown) => {
        console.error("Failed to read the transcription server's models:", err);
        setModels({
          status: "error",
          message: err instanceof Error ? err.message : "The transcription server did not answer.",
        });
      });
  }, []);

  useEffect(loadModels, [loadModels]);

  const storedModel = model ?? settings?.voiceModel ?? null;
  const modelValue = storedModel ?? MODEL_FROM_ENVIRONMENT;
  const storedLanguage = language ?? settings?.voiceLanguage ?? null;
  const languageValue = storedLanguage ?? DETECT_LANGUAGE;

  // The stored pick always has an entry, so the trigger never shows a blank.
  const modelOptions = useMemo(() => {
    const ids = [
      ...new Set([
        ...(models.status === "ready" ? models.models.map((entry) => entry.id) : []),
        ...(storedModel ? [storedModel] : []),
        DEFAULT_VOICE_MODEL,
      ]),
    ].sort((left, right) => left.localeCompare(right));

    return [
      {
        value: MODEL_FROM_ENVIRONMENT,
        label: "Environment default",
        hint: "Uses VOICE_MODEL, then the small model",
      },
      ...ids.map((id) => ({ value: id, label: id })),
    ];
  }, [models, storedModel]);

  const languageOptions = useMemo(() => {
    const codes = [
      ...new Set([
        ...(storedLanguage ? [storedLanguage] : []),
        ...VOICE_LANGUAGES.map((entry) => entry.code),
      ]),
    ];

    return [
      { value: DETECT_LANGUAGE, label: "Detect automatically" },
      ...codes.map((code) => ({
        value: code,
        label: VOICE_LANGUAGES.find((entry) => entry.code === code)?.label ?? code,
      })),
    ];
  }, [storedLanguage]);

  const saveAll = () =>
    void save({
      voiceEnabled: enabled ?? settings?.voiceEnabled ?? true,
      voiceModel: storedModel,
      voiceLanguage: storedLanguage,
    });

  return (
    <AdminSettingsFrame loading={loading} saving={saving} status={saveStatus} onSave={saveAll}>
      <PageSection title="Voice input">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <Label htmlFor="voice-enabled" className="text-sm font-medium">
              Offer speech input
            </Label>
            <p className="text-muted-foreground text-xs">
              Adds a microphone to the message box. VOICE_URL names the server that turns a
              recording into text.
            </p>
          </div>
          <Switch
            id="voice-enabled"
            checked={enabled ?? settings?.voiceEnabled ?? true}
            onCheckedChange={setEnabled}
          />
        </div>
      </PageSection>

      <PageSection title="Transcription">
        <SettingsRow
          htmlFor="voice-model"
          label="Model"
          description="The model the server decodes with."
        >
          <SearchSelect
            id="voice-model"
            placeholder="Choose a model"
            searchPlaceholder="Search models"
            options={modelOptions}
            value={modelValue}
            onChange={setModel}
            triggerClassName="w-36 sm:w-64"
          />
        </SettingsRow>

        <SettingsRow
          htmlFor="voice-language"
          label="Language"
          description="The language recordings are decoded as."
        >
          <SearchSelect
            id="voice-language"
            placeholder="Choose a language"
            searchPlaceholder="Search languages"
            options={languageOptions}
            value={languageValue}
            onChange={setLanguage}
            triggerClassName="w-32 sm:w-48"
          />
        </SettingsRow>

        <div className="flex items-center gap-2 px-4 pb-4">
          {models.status === "loading" ? (
            <span className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Reading the server&apos;s models
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              {models.status === "error"
                ? models.message
                : `${models.models.length} models on the server`}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={loadModels}>
            <RotateCw className="h-3.5 w-3.5" />
            Reload
          </Button>
        </div>
      </PageSection>
    </AdminSettingsFrame>
  );
}
