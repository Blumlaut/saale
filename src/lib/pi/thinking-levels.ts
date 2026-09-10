/**
 * Thinking (reasoning) levels — one source of truth for the settings UI, the
 * chat selector and every place that hands a level to Pi.
 *
 * Saale's extra `"default"` setting means "no opinion": it is stored like any
 * other setting, but resolves to `undefined` so the level is omitted from the
 * SDK options entirely and Pi keeps its own choice (the level recorded in the
 * session, the user's Pi setting, or Pi's built-in default). Passing a level
 * explicitly always overrides that — including `"off"`, which is why `"off"`
 * and `"default"` are distinct.
 */

/** Levels the Pi SDK accepts. */
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/** A stored thinking-level setting, including Saale's "let Pi decide". */
export type ThinkingLevelSetting = PiThinkingLevel | "default";

/** Stored when the user hasn't expressed a preference — Pi's own choice wins. */
export const DEFAULT_THINKING_LEVEL_SETTING: ThinkingLevelSetting = "default";

export interface ThinkingLevelOption {
  id: ThinkingLevelSetting;
  label: string;
  description: string;
}

/** Options for every thinking-level selector, in display order. */
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevelOption[] = [
  { id: "default", label: "Default", description: "Model's own default" },
  { id: "off", label: "Off", description: "Faster responses" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Basic reasoning" },
  { id: "medium", label: "Medium", description: "Balanced" },
  { id: "high", label: "High", description: "Deep reasoning" },
  { id: "xhigh", label: "X-High", description: "Maximum depth" },
  { id: "max", label: "Max", description: "Deepest reasoning" },
];

/** Whether a value is a level the SDK understands (excludes "default"). */
export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

/** Whether a value is a valid setting we can store. */
export function isThinkingLevelSetting(value: unknown): value is ThinkingLevelSetting {
  return value === "default" || isPiThinkingLevel(value);
}

/** Normalize an incoming setting for storage — unknown values mean "no opinion". */
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
