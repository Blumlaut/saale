import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockRequireSession } = vi.hoisted(() => ({ mockRequireSession: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

import { GET } from "@/app/api/voice/route";
import { POST } from "@/app/api/voice/transcribe/route";
import { MAX_VOICE_BYTES } from "@/lib/voice/config";

const env = process.env;

function recordingRequest(audio?: File, contentLength?: number) {
  const form = new FormData();
  if (audio) form.append("audio", audio);
  return new NextRequest("http://localhost/api/voice/transcribe", {
    method: "POST",
    headers: contentLength ? { "content-length": String(contentLength) } : {},
    body: form,
  });
}

function audio(size = 8): File {
  return new File([new Uint8Array(size)], "recording.webm", { type: "audio/webm" });
}

describe("voice routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
  });

  afterEach(() => {
    delete process.env.VOICE_URL;
    delete process.env.VOICE_MODEL;
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it("reports voice off when there is no transcription server", async () => {
    delete process.env.VOICE_URL;
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
  });

  it("reports voice on once a server is configured", async () => {
    process.env.VOICE_URL = "http://voice:8000";
    expect(await (await GET()).json()).toEqual({ enabled: true });
  });

  it("refuses a transcription when voice is off", async () => {
    delete process.env.VOICE_URL;
    const response = await POST(recordingRequest(audio()));
    expect(response.status).toBe(404);
  });

  it("refuses a body with no recording in it", async () => {
    process.env.VOICE_URL = "http://voice:8000";
    const response = await POST(recordingRequest());
    expect(response.status).toBe(400);
  });

  it("refuses a recording over the size ceiling", async () => {
    process.env.VOICE_URL = "http://voice:8000";
    const response = await POST(recordingRequest(audio(), MAX_VOICE_BYTES + 1));
    expect(response.status).toBe(413);
  });

  it("forwards the recording with the configured model and returns the text", async () => {
    process.env.VOICE_URL = "http://voice:8000/";
    process.env.VOICE_MODEL = "Systran/faster-whisper-base";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(form.get("model")).toBe("Systran/faster-whisper-base");
      expect(form.get("response_format")).toBe("json");
      expect((form.get("file") as File).size).toBe(8);
      return Response.json({ text: "  hello there  " });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(recordingRequest(audio()));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://voice:8000/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "hello there" });
  });

  it("answers 502 when the transcription server fails", async () => {
    process.env.VOICE_URL = "http://voice:8000";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("model loading failed", { status: 500 })),
    );

    const response = await POST(recordingRequest(audio()));
    expect(response.status).toBe(502);
  });

  it("answers 502 when the transcription server cannot be reached", async () => {
    process.env.VOICE_URL = "http://voice:8000";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const response = await POST(recordingRequest(audio()));
    expect(response.status).toBe(502);
  });

  it("tells the user when nothing was heard", async () => {
    process.env.VOICE_URL = "http://voice:8000";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ text: "   " })),
    );

    const response = await POST(recordingRequest(audio()));
    expect(response.status).toBe(422);
  });

  it("passes a 401 through from the session guard", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    process.env.VOICE_URL = "http://voice:8000";

    expect((await POST(recordingRequest(audio()))).status).toBe(401);
    expect((await GET()).status).toBe(401);
  });
});
