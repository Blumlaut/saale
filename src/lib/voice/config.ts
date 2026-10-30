/**
 * Voice input. `VOICE_URL` points at a faster-whisper server (Speaches), and
 * leaving it unset is how a deployment turns voice off: no mic in the
 * composer, no container, no model on disk.
 *
 * The server loads a model on the first request and unloads it again after a
 * stretch of idle time, so the memory it costs follows its use.
 *
 * No `node:` imports: the route and the client capability check both read it.
 */

/** Small enough to answer a sentence in about a second on a plain CPU. */
export const DEFAULT_VOICE_MODEL = "Systran/faster-whisper-small";

/** One recording. a couple of minutes of speech, never a file upload. */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

/** A cold model load plus a minute of audio stays under this. */
export const VOICE_TIMEOUT_MS = 90_000;

export interface VoiceConfig {
  /** Base URL of the transcription server, without a trailing slash. */
  url: string;
  /** The faster-whisper model the request names. */
  model: string;
  /** BCP-47 code the server decodes as, or null to let it detect the language. */
  language: string | null;
}

/** Null when this deployment has no transcription server. */
export function voiceConfig(): VoiceConfig | null {
  const url = process.env.VOICE_URL?.trim();
  if (!url) return null;

  return {
    url: url.replace(/\/+$/, ""),
    model: process.env.VOICE_MODEL?.trim() || DEFAULT_VOICE_MODEL,
    language: process.env.VOICE_LANGUAGE?.trim() || null,
  };
}
