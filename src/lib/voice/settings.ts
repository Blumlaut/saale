/**
 * The voice input settings, read from the admin settings row.
 *
 * Read per request, so a saved change applies to the next recording.
 */

import { prisma } from "@/lib/db";
import { resolveVoiceSettings, type VoiceSettings } from "@/lib/voice/options";

/** What this instance allows voice input to do. */
export async function readVoiceSettings(): Promise<VoiceSettings> {
  const row = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { voiceEnabled: true, voiceModel: true, voiceLanguage: true },
  });

  return resolveVoiceSettings({
    enabled: row?.voiceEnabled ?? true,
    model: row?.voiceModel ?? null,
    language: row?.voiceLanguage ?? null,
  });
}
