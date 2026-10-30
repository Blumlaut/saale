import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { MAX_VOICE_BYTES, VOICE_TIMEOUT_MS, voiceConfig } from "@/lib/voice/config";

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

  const upstreamForm = new FormData();
  upstreamForm.append("file", audio, audio.name || "recording.webm");
  upstreamForm.append("model", config.model);
  upstreamForm.append("response_format", "json");
  if (config.language) upstreamForm.append("language", config.language);

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}/v1/audio/transcriptions`, {
      method: "POST",
      body: upstreamForm,
      signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("Failed to reach the transcription server:", err);
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
