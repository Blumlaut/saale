/**
 * Agent tools for reading and changing Saale settings.
 *
 * Thin wrappers over the settings registry: the tools never name a setting, so
 * one added to `AppSettings`/`AdminSettings` (and registered) is immediately
 * settable with no change here.
 */

import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { createProjectSettingsTools } from "@/lib/coder/tools";
import { listSettings, setSetting, SettingsError, type PropertyView } from "./update";

/** Prefixes the model can filter on. a hint, not an allowlist. */
const KEY_PREFIXES = [
  "theme",
  "models.default",
  "models.thinkingLevel",
  "models.disabled",
  "models.purpose.<purpose>",
  "prompt.customInstructions",
  "prompt.emailWritingStyle",
  "tools.category.<category>.enabled",
  "tools.category.<category>.exposure",
  "tools.policy.<tool>",
  "sidebar.<item>.hidden",
  "admin.<setting>",
];

function toText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** One setting with its value, as a filtered listing reports it. */
const settingsPropertySchema = Type.Object({
  key: Type.String(),
  value: Type.Unknown(),
  description: Type.String(),
  values: Type.Optional(Type.Array(Type.String())),
});

function propertyJson(property: PropertyView): Static<typeof settingsPropertySchema> {
  return {
    key: property.key,
    value: property.value,
    description: property.description,
    ...(property.values ? { values: [...property.values] } : {}),
  };
}

const settingsListSchema = Type.Object({
  count: Type.Integer(),
  properties: Type.Array(settingsPropertySchema),
});

/** Every key grouped by area, without values. */
const settingsIndexSchema = Type.Object({
  groups: Type.Array(
    Type.Object({
      group: Type.String(),
      count: Type.Integer(),
      keys: Type.Array(Type.String()),
    }),
  ),
  hint: Type.String(),
});

const settingsSetSchema = Type.Object({
  key: Type.String(),
  label: Type.String(),
  value: Type.Unknown(),
});

/** An index of every key, grouped, without values. cheap to read in full. */
function groupProperties(
  properties: PropertyView[],
): { group: string; count: number; keys: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const property of properties) {
    const keys = groups.get(property.group) ?? [];
    keys.push(property.key);
    groups.set(property.group, keys);
  }
  return [...groups].map(([group, keys]) => ({ group, count: keys.length, keys }));
}

/**
 * The settings tools: the registry's, plus a coder project's own.
 *
 * `sessionId` is what lets the project tools default to the project of the chat
 * the agent is running in.
 */
export function createSettingsTools(userId: string, sessionId?: string): ToolDefinition[] {
  return [
    ...createProjectSettingsTools(userId, sessionId),
    defineStructuredTool({
      name: "settings_list",
      label: "List Settings",
      description: [
        "List Saale settings and their current values.",
        "Call with no arguments for an index of every key grouped by area; pass",
        '{ group: "tools.category" } for a prefix, or { key: "theme" } for one setting.',
        "Keys are dotted paths. Common shapes:",
        KEY_PREFIXES.join(", "),
        ".",
        "A value of null means the setting is at its default.",
      ].join(" "),
      parameters: Type.Object({
        group: Type.Optional(
          Type.String({
            description:
              'Key prefix to expand, e.g. "tools" or "tools.category.email". Returns values and descriptions.',
          }),
        ),
        key: Type.Optional(Type.String({ description: 'One exact key, e.g. "models.default".' })),
      }),
      // A filtered listing and the full index are different shapes, so a script
      // reads whichever the call produced.
      outputSchema: Type.Union([settingsListSchema, settingsIndexSchema]),
      execute: async (_toolCallId, params) => {
        const filter =
          typeof params.key === "string" && params.key.trim()
            ? { key: params.key.trim() }
            : typeof params.group === "string" && params.group.trim()
              ? { group: params.group.trim() }
              : undefined;

        const properties = await listSettings(userId, filter);

        if (filter && properties.length === 0) {
          throw new Error(
            `No settings match ${JSON.stringify(filter)}. Call settings_list with no arguments for the full index.`,
          );
        }

        const value = filter
          ? { count: properties.length, properties: properties.map(propertyJson) }
          : {
              groups: groupProperties(properties),
              hint: 'Call settings_list with { group: "<group>" } for values and descriptions, or { key: "<key>" } for one setting.',
            };

        return {
          value,
          text: toText(value),
          details: { count: properties.length },
        };
      },
    }),

    defineStructuredTool({
      name: "settings_set",
      label: "Change Setting",
      description: [
        "Change one Saale setting.",
        "Use settings_list to find the key and its allowed values, then pass the new",
        "value. Pass null to restore the setting to its default.",
        "Changes that this running conversation depends on (the model, tools and system",
        "prompt) take effect for this conversation's next session, and immediately for",
        "the user's other chats.",
      ].join(" "),
      parameters: Type.Object({
        key: Type.String({ description: 'The setting key, e.g. "theme" or "models.default".' }),
        value: Type.Optional(
          Type.Unknown({
            description:
              "The new value. Pass null to restore the default. Types must match the setting. see settings_list.",
          }),
        ),
      }),
      outputSchema: settingsSetSchema,
      execute: async (_toolCallId, params) => {
        const key = typeof params.key === "string" ? params.key.trim() : "";
        if (!key) {
          throw new Error("A setting key is required. Call settings_list to see the valid keys.");
        }
        if (!("value" in params) || params.value === undefined) {
          throw new Error(`A value is required for "${key}". Pass null to restore the default.`);
        }

        try {
          const property = await setSetting(userId, key, params.value);
          const value = {
            key: property.key,
            label: property.label,
            value: property.value,
          };

          return { value, text: toText(value), details: { key: property.key } };
        } catch (err) {
          // A rejected change is the model's to correct, so surface the reason
          // rather than a generic failure.
          if (err instanceof SettingsError) throw new Error(err.message);
          throw err;
        }
      },
    }),
  ];
}
