/**
 * Reading the JSON an AI job answers with.
 *
 * Jobs ask for raw JSON, and models still wrap it in a ```json fence often
 * enough that every caller has to strip one. The parse is the only part that
 * throws: each job decides whether an unusable answer means "nothing to do" or
 * a failed run.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON in an answer, with a code fence around it removed when there is one. */
export function parseAiJson(answer: string): unknown {
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse((fenced?.[1] ?? answer).trim());
}

/**
 * The answer as an object, or an empty one when it was not JSON at all.
 *
 * `context` names the job in the log line, so a model that keeps answering in
 * prose shows up as one job's problem rather than as lost work.
 */
export function readAiJson(answer: string, context: string): Record<string, unknown> {
  try {
    const parsed = parseAiJson(answer);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    console.error(`[${context}] The model did not answer with JSON:`, err);
    return {};
  }
}

/** The array of objects an answer holds under `key`, empty when it holds anything else. */
export function aiResultList(
  answer: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const value = answer[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
