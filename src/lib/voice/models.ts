/**
 * The models the transcription server offers.
 *
 * Speaches answers `GET /v1/models` with the models it has installed and can
 * install, so the admin picks from what the server serves.
 */

/** A model id the transcription endpoint accepts. */
export interface VoiceModel {
  id: string;
}

interface ModelsResponse {
  data?: unknown;
}

/**
 * The server's models, sorted by id.
 *
 * @throws {Error} When the deployment has no server or it does not answer.
 */
export async function fetchVoiceModels(timeoutMs = 5_000): Promise<VoiceModel[]> {
  const url = process.env.VOICE_URL?.trim();
  if (!url) throw new Error("VOICE_URL is not set");

  const response = await fetch(`${url.replace(/\/+$/, "")}/v1/models`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as ModelsResponse;
  const models: VoiceModel[] = [];

  for (const entry of Array.isArray(body.data) ? body.data : []) {
    const model = entry as Record<string, unknown>;
    const id = typeof model.id === "string" ? model.id : "";
    if (!id) continue;
    models.push({ id });
  }

  return models.sort((left, right) => left.id.localeCompare(right.id));
}
