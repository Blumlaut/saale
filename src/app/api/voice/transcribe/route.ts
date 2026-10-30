import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  MAX_VOICE_BYTES,
  VOICE_DOWNLOAD_TIMEOUT_MS,
  VOICE_TIMEOUT_MS,
  voiceConfig,
  type VoiceConfig,
} from "@/lib/voice/config";

/** Send the recording on, as the OpenAI transcription endpoint wants it. */
function requestTranscription(audio: File, config: VoiceConfig): Promise<Response> {
  const form = new FormData();
  form.append("file", audio, audio.name || "recording.webm");
  form.append("model", config.model);
  form.append("response_format", "json");
  if (config.language) form.append("language", config.language);

  return fetch(`${config.url}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
  });
}

/**
 * Ask the server for the model it said it lacks.
 *
 * A fresh server has none, and the transcription endpoint does not fetch one on
 * its own, so the first recording installs it. That download is the slow part
 * of a deployment's first day, not of a recording.
 */
async function installModel(config: VoiceConfig): Promise<void> {
  try {
    const response = await fetch(`${config.url}/v1/models/${config.model}`, {
      method: "POST",
      signal: AbortSignal.timeout(VOICE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `The transcription server refused to install ${config.model}:`,
        response.status,
        detail.slice(0, 500),
      );
    }
  } catch (err) {
    console.error(`Failed to ask the transcription server for ${config.model}:`, err);
  }
}

/**
 * POST /api/voice/transcribe. A recording in, its text out.
 *
 * The browser sends the blob it recorded; this route forwards it to the
 * transcription server and returns only the text. Nothing is stored.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const config = voiceConfig();
  if (!config) {
    return NextResponse.json({ error: "Voice input is off on this instance" }, { status: 404 });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_VOICE_BYTES) {
    return NextResponse.json({ error: "That recording is too long" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error("Failed to read the recording's form data:", err);
    return NextResponse.json({ error: "The recording did not arrive" }, { status: 400 });
  }

  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "No recording was sent" }, { status: 400 });
  }
  if (audio.size > MAX_VOICE_BYTES) {
    return NextResponse.json({ error: "That recording is too long" }, { status: 413 });
  }

  let upstream: Response;
  try {
    upstream = await requestTranscription(audio, config);
    if (upstream.status === 404) {
      await installModel(config);
      upstream = await requestTranscription(audio, config);
    }
  } catch (err) {
    console.error(`Failed to reach the transcription server at ${config.url}:`, err);
    return NextResponse.json({ error: "The transcription server did not answer" }, { status: 502 });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error(`Transcription server answered ${upstream.status}:`, detail.slice(0, 500));
    return NextResponse.json({ error: "Speech could not be transcribed" }, { status: 502 });
  }

  const data = (await upstream.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof data?.text === "string" ? data.text.trim() : "";
  if (!text) {
    return NextResponse.json(
      { error: "Nothing was picked up. try speaking closer" },
      { status: 422 },
    );
  }

  return NextResponse.json({ text });
}
