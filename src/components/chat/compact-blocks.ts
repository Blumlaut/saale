import type { Message, ToolCallData } from "./types";

/** One step's contribution to a run: what it reasoned and the work it did. */
export interface CompactStep {
  id: string;
  thinking: string;
  work: ToolCallData[];
}

/** A block of the condensed transcript: a run of activity, or what a step said. */
export type CompactBlock =
  | { kind: "activity"; key: string; steps: CompactStep[] }
  | { kind: "attachments"; key: string; toolCalls: ToolCallData[] }
  | { kind: "message"; key: string; message: Message };

/** A turn's calls, split by how the surface has to render them. */
export interface CompactSplit {
  work: ToolCallData[];
  attachments: ToolCallData[];
}

/**
 * Fold a turn's steps into the condensed transcript.
 *
 * A step that reasoned or worked joins the run above it; a step that said
 * something ends that run, so a sentence is read after the activity that
 * produced it and the next step starts a fresh run. Files the turn showed the
 * user are never folded in. they are the thing to look at, not a record of
 * work. so each surface supplies its own `split`, and `<ToolCallGroup>` knows
 * which calls are which.
 *
 * One step can produce several blocks (its activity, its prose, its files), so
 * a block's key is the step's id *and* its kind: React drops or duplicates
 * siblings that share a key, which is exactly the block vanishing mid-stream
 * and reappearing on a reload.
 */
export function compactBlocks(
  messages: readonly Message[],
  split: (toolCalls: readonly ToolCallData[]) => CompactSplit,
): CompactBlock[] {
  const blocks: CompactBlock[] = [];

  for (const message of messages) {
    const { attachments, work } = split(message.toolCalls ?? []);

    if (message.thinking || work.length > 0) {
      const step: CompactStep = {
        id: message.id,
        thinking: message.thinking?.trim() ?? "",
        work,
      };
      const open = blocks[blocks.length - 1];
      if (open?.kind === "activity") open.steps.push(step);
      else blocks.push({ kind: "activity", key: `${message.id}:activity`, steps: [step] });
    }

    if (message.content || message.errorMessage) {
      blocks.push({ kind: "message", key: `${message.id}:prose`, message });
    }

    if (attachments.length > 0) {
      blocks.push({
        kind: "attachments",
        key: `${attachments[0]!.id}:files`,
        toolCalls: attachments,
      });
    }
  }

  return blocks;
}
