/**
 * What the admin settings say about voice input.
 *
 * Pure data, no Node or database imports: the admin page and the routes read the
 * same defaults. A null model or language follows the environment.
 */

import { isVoiceLanguage } from "@/lib/voice/languages";

/** Small enough to answer a sentence in about a second on a plain CPU. */
export const DEFAULT_VOICE_MODEL = "Systran/faster-whisper-small";

export interface VoiceSettings {
  enabled: boolean;
  /** The faster-whisper model a transcription names. */
  model: string;
  /** Language code the server decodes as, or null to let it detect the language. */
  language: string | null;
}

/** The settings as stored: nulls follow the environment. */
export interface StoredVoiceSettings {
  enabled: boolean;
  model: string | null;
  language: string | null;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: true,
  model: DEFAULT_VOICE_MODEL,
  language: null,
};

/**
 * The stored settings, with the environment filling whatever they leave null.
 *
 * A language the list does not know is kept: a server may decode more than
 * Whisper's own table.
 */
export function resolveVoiceSettings(
  stored: StoredVoiceSettings,
  env: NodeJS.ProcessEnv = process.env,
): VoiceSettings {
  const envModel = env.VOICE_MODEL?.trim();
  const envLanguage = env.VOICE_LANGUAGE?.trim();

  return {
    enabled: stored.enabled && env.VOICE_ENABLED !== "0",
    model: stored.model?.trim() || envModel || DEFAULT_VOICE_MODEL,
    language: stored.language?.trim() || envLanguage || null,
  };
}

/** Whether a code is one the transcription server decodes. */
export function isKnownVoiceLanguage(code: string): boolean {
  return isVoiceLanguage(code);
}
