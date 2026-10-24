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
 * A step reasons, says its piece, then calls the tools that piece asked for, so
 * its sentence is emitted between its reasoning and its work. Reasoning never
 * resumes a run a sentence closed: the row would land above the sentence, and
 * the call the sentence introduced would read as the next step's.
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
  /** The run new steps fold into; null once prose or files sit between them. */
  let open: Extract<CompactBlock, { kind: "activity" }> | null = null;
  /** A sentence closed the run's reasoning (see above). */
  let closed = false;

  const addActivity = (step: CompactStep, key: string) => {
    const reasoning = step.thinking.length > 0;
    if (open && !(reasoning && closed)) {
      open.steps.push(step);
      return;
    }
    const block = { kind: "activity" as const, key, steps: [step] };
    blocks.push(block);
    open = block;
    closed = false;
  };

  for (const message of messages) {
    const { attachments, work } = split(message.toolCalls ?? []);
    const thinking = message.thinking?.trim() ?? "";

    if (message.content || message.errorMessage) {
      if (thinking) addActivity({ id: message.id, thinking, work: [] }, `${message.id}:activity`);
      blocks.push({ kind: "message", key: `${message.id}:prose`, message });
      open = null;
      if (work.length > 0)
        addActivity({ id: message.id, thinking: "", work }, `${message.id}:work`);
      closed = open !== null;
    } else if (thinking || work.length > 0) {
      addActivity({ id: message.id, thinking, work }, `${message.id}:activity`);
    }

    if (attachments.length > 0) {
      blocks.push({
        kind: "attachments",
        key: `${attachments[0]!.id}:files`,
        toolCalls: attachments,
      });
      open = null;
    }
  }

  return blocks;
}
