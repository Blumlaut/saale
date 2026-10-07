"use client";

import type { ComponentType } from "react";
import { ShowFileCard } from "./file-card";
import { ToolCard } from "./tool-card";
import { calendarToolDescriptor } from "./tool-descriptors/calendar";
import { codemodeDescriptor } from "./tool-descriptors/codemode";
import { describeGenericToolCall } from "./tool-descriptors/generic";
import { infraToolDescriptor } from "./tool-descriptors/infra";
import { mailToolDescriptor } from "./tool-descriptors/mail";
import { webToolDescriptor } from "./tool-descriptors/web";
import type { ToolDescriptor } from "./tool-card-model";
import type { ToolCallData } from "./types";

/**
 * Tool-call routing — the one place a tool name becomes something renderable.
 *
 * A route either describes a card (every normal tool) or is a bespoke
 * component. `show_file` is the only bespoke one: it is an attachment — a
 * preview and a download — rather than a report of what a call did, so it has
 * no card model to describe. Everything else is data in `./tool-descriptors`.
 *
 * The owner's path: `MessageList` renders `ToolCallView`, which resolves
 * through here. The share viewer renders `RedactedToolCall` directly, so a
 * descriptor added below can never reach a public page —
 * `__tests__/share-redaction-coverage.test.ts` enforces that.
 */

/** What the transcript renders for one tool call. */
export type ToolCardRenderer = ComponentType<{ toolCall: ToolCallData }>;

interface ToolCardRoute {
  names?: readonly string[];
  prefixes?: readonly string[];
  render: ToolCardRenderer;
}

/** The card every unrouted tool renders, and every failed lookup falls back to. */
const GenericToolCard: ToolCardRenderer = function GenericToolCard({ toolCall }) {
  return <ToolCard model={describeGenericToolCall(toolCall)} />;
};

/**
 * Wraps a descriptor as a card.
 *
 * A descriptor that finds nothing it understands hands over to the generic
 * card rather than rendering nothing: a call showing its raw arguments beats a
 * call the user cannot see at all.
 */
function modelCard(descriptor: ToolDescriptor): ToolCardRenderer {
  function DescribedToolCard({ toolCall }: { toolCall: ToolCallData }) {
    const model = descriptor.describe(toolCall);
    if (!model) return <GenericToolCard toolCall={toolCall} />;
    return <ToolCard model={model} />;
  }
  return DescribedToolCard;
}

function route(descriptor: ToolDescriptor): ToolCardRoute {
  return {
    ...(descriptor.names ? { names: descriptor.names } : {}),
    ...(descriptor.prefixes ? { prefixes: descriptor.prefixes } : {}),
    render: modelCard(descriptor),
  };
}

/** First match wins, so the order below is the routing table. */
const ROUTES: readonly ToolCardRoute[] = [
  { names: ["show_file"], render: ShowFileCard },
  route(webToolDescriptor),
  route(mailToolDescriptor),
  route(calendarToolDescriptor),
  route(infraToolDescriptor),
  route(codemodeDescriptor),
];

/** The card for a tool call's name, or the generic card. */
export function resolveToolCard(name: string): ToolCardRenderer {
  for (const toolRoute of ROUTES) {
    if (toolRoute.names?.includes(name)) return toolRoute.render;
    if (toolRoute.prefixes?.some((prefix) => name.startsWith(prefix))) return toolRoute.render;
  }
  return GenericToolCard;
}
