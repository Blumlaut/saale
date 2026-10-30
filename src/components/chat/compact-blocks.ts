import { messageKey } from "@/lib/chat/message-factories";
import type { Message, ToolCallData } from "./types";

/** One step's contribution to a run: what it reasoned and the work it did. */
export interface CompactStep {
  id: string;
  thinking: string;
  work: readonly ToolCallData[];
}

/** A block of the condensed transcript: a run of activity, or what a step said. */
export type CompactBlock =
  | { kind: "activity"; key: string; steps: CompactStep[] }
  | { kind: "attachments"; key: string; toolCalls: readonly ToolCallData[] }
  | { kind: "message"; key: string; message: Message };

/** A turn's calls, split by how the surface has to render them. */
export interface CompactSplit {
  work: readonly ToolCallData[];
  attachments: readonly ToolCallData[];
}

/**
 * Fold a turn's steps into the condensed transcript.
 *
 * A step joins the run above it, reasoning and work together, and a step that
 * said something ends that run: its sentence is read under the card that did
 * the work. Files the turn showed the user are never folded in. they are the
 * thing to look at, not a record of work. so each surface supplies its own
 * `split`, and `<ToolCallGroup>` knows which calls are which.
 *
 * A step's reasoning never lands in a card other than the one holding its
 * calls. The transcript is rebuilt on every stream event, so a step that is
 * re-parented once its prose arrives is a row that jumps between cards
 * mid-run, which reads as the summary vanishing and coming back.
 *
 * One step can produce several blocks (its activity, its prose, its files), so
 * a block's key is the step's id *and* its kind: React drops or duplicates
 * siblings that share a key, which is exactly the block vanishing mid-stream
 * and reappearing on a reload.
 *
 * The id is the step's render identity, not its row id: a live step is renamed
 * when it is saved, and a key that follows the rename would remount the block,
 * folding shut every card the user opened while the turn was still working.
 */
export function compactBlocks(
  messages: readonly Message[],
  split: (toolCalls: readonly ToolCallData[]) => CompactSplit,
): CompactBlock[] {
  const blocks: CompactBlock[] = [];
  /** The run new steps fold into; null once prose or files sit between them. */
  let open: Extract<CompactBlock, { kind: "activity" }> | null = null;

  for (const message of messages) {
    const { attachments, work } = split(message.toolCalls ?? []);
    const thinking = message.thinking?.trim() ?? "";
    const key = messageKey(message);

    if (thinking || work.length > 0) {
      const step: CompactStep = { id: key, thinking, work };
      if (open) open.steps.push(step);
      else {
        const block = { kind: "activity" as const, key: `${key}:activity`, steps: [step] };
        blocks.push(block);
        open = block;
      }
    }

    if (message.content || message.errorMessage) {
      blocks.push({ kind: "message", key: `${key}:prose`, message });
      open = null;
    }

    if (attachments.length > 0) {
      blocks.push({
        kind: "attachments",
        key: `${key}:files`,
        toolCalls: attachments,
      });
      open = null;
    }
  }

  return blocks;
}
