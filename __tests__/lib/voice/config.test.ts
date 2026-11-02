import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { adminSettings: { findUnique: mocks.findUnique } },
}));

import { voiceConfig } from "@/lib/voice/config";
import { DEFAULT_VOICE_MODEL } from "@/lib/voice/options";

const env = process.env;

/** The columns the voice reader selects, as the row holds them. */
function stored(voice: { enabled: boolean; model: string | null; language: string | null } | null) {
  mocks.findUnique.mockResolvedValue(
    voice
      ? { voiceEnabled: voice.enabled, voiceModel: voice.model, voiceLanguage: voice.language }
      : null,
  );
}

beforeEach(() => {
  process.env = { ...env };
  delete process.env.VOICE_ENABLED;
  delete process.env.VOICE_MODEL;
  delete process.env.VOICE_LANGUAGE;
  delete process.env.VOICE_URL;
  mocks.findUnique.mockReset();
  stored(null);
});

afterEach(() => {
  process.env = { ...env };
});

describe("voiceConfig", () => {
  it("is off until a transcription server is configured", async () => {
    expect(await voiceConfig()).toBeNull();
  });

  it("treats a blank URL as off", async () => {
    process.env.VOICE_URL = "   ";
    expect(await voiceConfig()).toBeNull();
  });

  it("takes the model and language from the admin settings", async () => {
    process.env.VOICE_URL = "http://voice:8000/";
    stored({ enabled: true, model: "Systran/faster-whisper-base", language: "de" });

    expect(await voiceConfig()).toEqual({
      url: "http://voice:8000",
      model: "Systran/faster-whisper-base",
      language: "de",
    });
  });

  it("follows the environment for a value the settings leave null", async () => {
    process.env.VOICE_URL = "http://voice:8000";
    process.env.VOICE_MODEL = "Systran/faster-whisper-base";
    process.env.VOICE_LANGUAGE = "de";
    stored({ enabled: true, model: null, language: null });

    expect(await voiceConfig()).toEqual({
      url: "http://voice:8000",
      model: "Systran/faster-whisper-base",
      language: "de",
    });
  });

  it("defaults to the small model and no language of its own", async () => {
    process.env.VOICE_URL = "http://voice:8000";

    expect(await voiceConfig()).toEqual({
      url: "http://voice:8000",
      model: DEFAULT_VOICE_MODEL,
      language: null,
    });
  });

  it("is off when the admin switch is off", async () => {
    process.env.VOICE_URL = "http://voice:8000";
    stored({ enabled: false, model: null, language: null });

    expect(await voiceConfig()).toBeNull();
  });

  it("is off when the deployment turns it off, whatever the settings say", async () => {
    process.env.VOICE_ENABLED = "0";
    process.env.VOICE_URL = "http://voice:8000";
    stored({ enabled: true, model: null, language: null });

    expect(await voiceConfig()).toBeNull();
  });
});
