import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_VOICE_MODEL, voiceConfig } from "@/lib/voice/config";

const env = process.env;

afterEach(() => {
  process.env = { ...env };
  delete process.env.VOICE_ENABLED;
  delete process.env.VOICE_URL;
  delete process.env.VOICE_MODEL;
  delete process.env.VOICE_LANGUAGE;
});

describe("voiceConfig", () => {
  it("is off when the deployment turns it off", () => {
    process.env.VOICE_ENABLED = "0";
    process.env.VOICE_URL = "http://voice:8000";
    expect(voiceConfig()).toBeNull();
  });

  it("stays on for any other value of the switch", () => {
    process.env.VOICE_ENABLED = "1";
    process.env.VOICE_URL = "http://voice:8000";
    expect(voiceConfig()?.url).toBe("http://voice:8000");
  });

  it("is off until a transcription server is configured", () => {
    delete process.env.VOICE_URL;
    expect(voiceConfig()).toBeNull();
  });

  it("treats a blank URL as off", () => {
    process.env.VOICE_URL = "   ";
    expect(voiceConfig()).toBeNull();
  });

  it("defaults to the small model and no language of its own", () => {
    process.env.VOICE_URL = "http://voice:8000";
    expect(voiceConfig()).toEqual({
      url: "http://voice:8000",
      model: DEFAULT_VOICE_MODEL,
      language: null,
    });
  });

  it("trims a trailing slash and takes the configured model and language", () => {
    process.env.VOICE_URL = "http://voice:8000/";
    process.env.VOICE_MODEL = "Systran/faster-whisper-base";
    process.env.VOICE_LANGUAGE = "de";

    expect(voiceConfig()).toEqual({
      url: "http://voice:8000",
      model: "Systran/faster-whisper-base",
      language: "de",
    });
  });
});
