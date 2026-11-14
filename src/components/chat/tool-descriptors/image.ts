import { Frame, Sparkles } from "lucide-react";
import { extractToolMeta } from "@/lib/chat/tool-meta";
import { truncate } from "@/lib/format";
import { toolIcon } from "@/lib/pi/tool-infos";
import { isToolCallInProgress, toolStatus } from "../tool-status";
import type { ToolCardBlock, ToolCardModel, ToolDescriptor, ToolFact } from "../tool-card-model";

/** Longest prompt shown beside the card's title. */
const MAX_PROMPT = 80;

/** The metadata block the image tool appends to its result. */
interface ImageMeta {
  type?: string;
  path: string;
  model: string;
  provider: string;
  prompt: string;
  width: number;
  height: number;
}

/**
 * The image card: what was rendered, shown as the picture itself.
 *
 * The tool writes the file into the workspace and reports its path, so the card
 * previews it the way a `read` of an image does, with the prompt and the size
 * above it.
 */
export const imageToolDescriptor: ToolDescriptor = {
  names: ["generate_image"],
  describe(toolCall): ToolCardModel | null {
    const meta = extractToolMeta<ImageMeta>(toolCall.result);
    if (!meta?.path) return null;

    const facts: ToolFact[] = [
      { icon: Sparkles, text: meta.model, note: meta.provider },
      { icon: Frame, text: `${meta.width}×${meta.height}` },
    ];

    const blocks: ToolCardBlock[] = [
      { kind: "image", path: meta.path },
      { kind: "facts", items: facts },
    ];

    return {
      icon: toolIcon("generate_image"),
      title: "Generate Image",
      detail: truncate(meta.prompt, MAX_PROMPT),
      status: toolStatus(
        toolCall,
        isToolCallInProgress(toolCall) ? undefined : `${meta.width}×${meta.height}`,
      ),
      blocks,
    };
  },
};
