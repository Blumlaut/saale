/**
 * Voice input, decoded by a faster-whisper server (Speaches). `VOICE_URL` names
 * the server, and empty means "no server here", which is what a bare
 * `npm run dev` on a host without the container gets.
 *
 * The switch, the model and the language come from the admin settings, falling
 * back to VOICE_ENABLED, VOICE_MODEL and VOICE_LANGUAGE.
 *
 * The server loads a model on the first request and unloads it again after a
 * stretch of idle time, so the memory it costs follows its use.
 */

import { readVoiceSettings } from "@/lib/voice/settings";

/** One recording. a couple of minutes of speech, never a file upload. */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

/** A cold model load plus a minute of audio stays under this. */
export const VOICE_TIMEOUT_MS = 90_000;

/** The server fetches a few hundred MB on the first recording. */
export const VOICE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface VoiceConfig {
  /** Base URL of the transcription server, without a trailing slash. */
  url: string;
  /** The faster-whisper model the request names. */
  model: string;
  /** BCP-47 code the server decodes as, or null to let it detect the language. */
  language: string | null;
}

/** Null when this deployment has no transcription server, or voice is off. */
export async function voiceConfig(): Promise<VoiceConfig | null> {
  const url = process.env.VOICE_URL?.trim();
  if (!url) return null;

  const settings = await readVoiceSettings();
  if (!settings.enabled) return null;

  return {
    url: url.replace(/\/+$/, ""),
    model: settings.model,
    language: settings.language,
  };
}
