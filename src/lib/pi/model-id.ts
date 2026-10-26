/**
 * Model ids live in two shapes: the picker works in `provider/modelId`, and the
 * database and job configs store `provider:modelId`.
 */

/** `provider/modelId` from the picker to the stored `provider:modelId`. */
export function toStoredModelId(value: string): string {
  return value.replace("/", ":");
}

/** Stored `provider:modelId` to the `provider/modelId` the picker expects. */
export function toPickerModelId(value: string): string {
  return value.replace(":", "/");
}

/** Stored id as `modelId (provider)` for a read-only display. */
export function formatModelId(value: string | null | undefined): string | null {
  if (!value) return null;
  const [provider, ...name] = value.split(":");
  if (name.length === 0) return value;
  return `${name.join(":")} (${provider})`;
}
