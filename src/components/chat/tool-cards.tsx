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
import type { ToolCardModel, ToolDescriptor } from "./tool-card-model";
import type { ToolCallData } from "./types";

/**
 * Tool-call routing. the one place a tool name becomes something renderable.
 *
 * A route either describes a card (every normal tool) or is a bespoke
 * component. `show_file` is the only bespoke one: it is an attachment. a
 * preview and a download. rather than a report of what a call did, so it has
 * no card model to describe. Everything else is data in `./tool-descriptors`.
 *
 * The owner's path: `MessageList` renders `ToolCallGroup`, which resolves each
 * call through here. The share viewer renders `RedactedToolCall` directly, so a
 * descriptor added below can never reach a public page
 * `__tests__/share-redaction-coverage.test.ts` enforces that.
 */

/** What the transcript renders for one tool call. */
export type ToolCardRenderer = ComponentType<{ toolCall: ToolCallData }>;

interface ToolCardRoute {
  names?: readonly string[];
  prefixes?: readonly string[];
  /**
   * The call hands the user something to look at instead of reporting work.
   * `ToolCallGroup` renders these open, outside the collapsed run.
   */
  attachment?: true;
  /** The family's describe, kept so an icon can be read without rendering. */
  describe?: ToolDescriptor["describe"];
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
    describe: descriptor.describe,
    render: modelCard(descriptor),
  };
}

/** First match wins, so the order below is the routing table. */
const ROUTES: readonly ToolCardRoute[] = [
  { names: ["show_file"], attachment: true, render: ShowFileCard },
  route(webToolDescriptor),
  route(mailToolDescriptor),
  route(calendarToolDescriptor),
  route(infraToolDescriptor),
  route(codemodeDescriptor),
];

/** The route that owns a tool name. the first match, as in the table. */
function findRoute(name: string): ToolCardRoute | undefined {
  return ROUTES.find(
    (toolRoute) =>
      toolRoute.names?.includes(name) ||
      toolRoute.prefixes?.some((prefix) => name.startsWith(prefix)),
  );
}

/** The card for a tool call's name, or the generic card. */
export function resolveToolCard(name: string): ToolCardRenderer {
  return findRoute(name)?.render ?? GenericToolCard;
}

/**
 * The model a call's descriptor reads out of it, or null when no descriptor
 * owns the name (or the result carries nothing a descriptor understands).
 *
 * The compact activity row only needs the icon, but it comes through the same
 * descriptor the full card does, so a tool's mark never drifts from its card.
 */
export function describeToolCard(name: string, toolCall: ToolCallData): ToolCardModel | null {
  return findRoute(name)?.describe?.(toolCall) ?? null;
}

/** A turn's tool calls, split by how they have to render. */
export interface ToolCallSplit {
  /** Attachments: the files the turn is showing the user. Never collapsed. */
  attachments: ToolCallData[];
  /** The rest. what the turn did. Collapsed into one row when there are several. */
  work: ToolCallData[];
}

/**
 * Split a turn's calls into the files it showed the user and the calls that
 * report what it did, preserving the order within each list.
 */
export function splitToolCalls(calls: readonly ToolCallData[]): ToolCallSplit {
  const attachments: ToolCallData[] = [];
  const work: ToolCallData[] = [];

  for (const call of calls) {
    if (findRoute(call.name)?.attachment) attachments.push(call);
    else work.push(call);
  }

  return { attachments, work };
}
