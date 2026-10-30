/**
 * Voice input, decoded by a faster-whisper server (Speaches). The compose file
 * points the app at that server by default, and `VOICE_ENABLED=0` turns the
 * feature off: no mic in the composer, and the routes answer 404.
 *
 * `VOICE_URL` names a different server, and empty means "no server here", which
 * is what a bare `npm run dev` on a host without the container gets.
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
export function voiceConfig(): VoiceConfig | null {
  if (process.env.VOICE_ENABLED === "0") return null;

  const url = process.env.VOICE_URL?.trim();
  if (!url) return null;

  return {
    url: url.replace(/\/+$/, ""),
    model: process.env.VOICE_MODEL?.trim() || DEFAULT_VOICE_MODEL,
    language: process.env.VOICE_LANGUAGE?.trim() || null,
  };
}
