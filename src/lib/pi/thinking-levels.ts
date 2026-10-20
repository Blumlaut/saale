/**
 * Thinking (reasoning) levels. one source of truth for the settings UI, the
 * chat selector and every place that hands a level to Pi.
 *
 * Pi owns the levels (`ThinkingLevel`) and the order; the labels and
 * descriptions below are Saale's presentation of them, so a level Pi adds or
 * drops fails the build here instead of silently drifting.
 *
 * Saale's extra `"default"` setting means "no opinion": it is stored like any
 * other setting, but resolves to `undefined` so the level is omitted from the
 * SDK options entirely and Pi keeps its own choice (the level recorded in the
 * session, the user's Pi setting, or Pi's built-in default). Passing a level
 * explicitly always overrides that. including `"off"`, which is why `"off"`
 * and `"default"` are distinct.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type PiThinkingLevel = ThinkingLevel;

const LEVEL_TEXT: Record<ThinkingLevel, { label: string; description: string }> = {
  off: { label: "Off", description: "Faster responses" },
  minimal: { label: "Minimal", description: "Light reasoning" },
  low: { label: "Low", description: "Basic reasoning" },
  medium: { label: "Medium", description: "Balanced" },
  high: { label: "High", description: "Deep reasoning" },
  xhigh: { label: "X-High", description: "Maximum depth" },
  max: { label: "Max", description: "Deepest reasoning" },
};

/** Levels the Pi SDK accepts, in Pi's order (cheapest to deepest). */
export const PI_THINKING_LEVELS = Object.keys(LEVEL_TEXT) as PiThinkingLevel[];

/** A stored thinking-level setting, including Saale's "let Pi decide". */
export type ThinkingLevelSetting = PiThinkingLevel | "default";

/** Stored when the user hasn't expressed a preference. Pi's own choice wins. */
export const DEFAULT_THINKING_LEVEL_SETTING: ThinkingLevelSetting = "default";

export interface ThinkingLevelOption {
  id: ThinkingLevelSetting;
  label: string;
  description: string;
}

/** Options for every thinking-level selector, in display order. */
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevelOption[] = [
  { id: "default", label: "Default", description: "Model's own default" },
  ...PI_THINKING_LEVELS.map((id) => ({ id, ...LEVEL_TEXT[id] })),
];

/**
 * The options to show for a model: only levels it supports, plus "default",
 * which is not a capability but "don't override Pi".
 *
 * `available` is `getSupportedThinkingLevels()` for the model, or `null` while
 * that is unknown. an unknown model must not hide anything.
 */
export function thinkingLevelOptionsFor(
  available: readonly string[] | null,
): readonly ThinkingLevelOption[] {
  if (!available) return THINKING_LEVEL_OPTIONS;
  return THINKING_LEVEL_OPTIONS.filter((l) => l.id === "default" || available.includes(l.id));
}

/** Whether a value is a level the SDK understands (excludes "default"). */
export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && Object.hasOwn(LEVEL_TEXT, value);
}

/** Whether a value is a valid setting we can store. */
export function isThinkingLevelSetting(value: unknown): value is ThinkingLevelSetting {
  return value === "default" || isPiThinkingLevel(value);
}

/** Normalize an incoming setting for storage. unknown values mean "no opinion". */
export function normalizeThinkingLevelSetting(value: unknown): ThinkingLevelSetting {
  return isThinkingLevelSetting(value) ? value : DEFAULT_THINKING_LEVEL_SETTING;
}

/**
 * Resolve a stored setting to the value handed to Pi.
 *
 * @returns the level, or `undefined` when Saale should not override Pi.
 */
function resolveThinkingLevel(value: string | null | undefined): PiThinkingLevel | undefined {
  return isPiThinkingLevel(value) ? value : undefined;
}

/**
 * Spreadable SDK option for a stored thinking level:
 *
 * ```ts
 * createAgentSession({ ...base, ...thinkingLevelOption(session.thinkingLevel) })
 * ```
 *
 * Empty for "default" (or an unset/unknown setting), so the option is omitted
 * and Pi keeps its own level.
 */
export function thinkingLevelOption(setting: string | null | undefined): {
  thinkingLevel?: PiThinkingLevel;
} {
  const level = resolveThinkingLevel(setting);
  return level ? { thinkingLevel: level } : {};
}
