/**
 * Model reference parsing. shared by model resolution and the settings
 * registry.
 *
 * A reference is `provider:modelId` (Saale's storage format) or
 * `provider/modelId` (Pi's canonical form).
 *
 * Only the FIRST separator is the provider boundary: model ids contain both
 * characters. `openrouter:anthropic/claude-sonnet-4`, `openai/gpt-5:exacto`
 * so splitting on a later one, or rewriting the id's own separator, changes
 * the model identity and the runtime can no longer resolve it.
 */

export interface ModelReference {
  provider: string;
  name: string;
}

/**
 * Split a model reference into its provider and model id.
 *
 * @returns The provider and model id, or undefined when the reference carries
 *   no provider prefix (a bare model id is not resolvable on its own).
 */
export function splitModelReference(
  modelReference: string | null | undefined,
): ModelReference | undefined {
  const reference = modelReference?.trim();
  if (!reference) return undefined;

  const separator = reference.search(/[:/]/);
  if (separator <= 0) return undefined;

  const provider = reference.slice(0, separator);
  const name = reference.slice(separator + 1);
  if (!provider || !name) return undefined;

  return { provider, name };
}

/**
 * The canonical `provider:model` form of a stored pair, or null when either
 * half is missing (an unset default, or a half-written row).
 */
export function formatModelReference(
  provider: string | null | undefined,
  name: string | null | undefined,
): string | null {
  const trimmedProvider = provider?.trim();
  const trimmedName = name?.trim();
  if (!trimmedProvider || !trimmedName) return null;
  return `${trimmedProvider}:${trimmedName}`;
}

/**
 * The stored form of a reference the picker handed back, which works in
 * `provider/modelId`.
 */
export function toStoredModelId(reference: string): string {
  return reference.replace("/", ":");
}

/** The `provider/modelId` form the pickers work in, from the stored form. */
export function toPickerModelId(reference: string): string {
  return reference.replace(":", "/");
}

/** A reference written out as `modelId (provider)` where it reads better. */
export function formatModelId(reference: string | null | undefined): string | null {
  const parts = splitModelReference(reference);
  if (!parts) return reference?.trim() || null;
  return `${parts.name} (${parts.provider})`;
}
