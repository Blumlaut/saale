import { Frame, Sparkles } from "lucide-react";
import { extractToolMeta } from "@/lib/chat/tool-meta";
import { truncate } from "@/lib/format";
import { toolIcon } from "@/lib/pi/tool-infos";
import { isToolCallInProgress, toolStatus } from "../tool-status";
import type { ToolCardBlock, ToolCardModel, ToolDescriptor, ToolFact } from "../tool-card-model";
import type { ToolCallData } from "../types";

/** Longest prompt shown beside the card's title. */
const MAX_PROMPT = 80;

/** The metadata block the image tools append to their result. */
interface ImageMeta {
  type?: string;
  path: string;
  model: string;
  provider: string;
  prompt: string;
  width: number;
  height: number;
}

/** What each tool is called, wherever the card names it. */
const TITLES: Record<string, string> = {
  generate_image: "Generate Image",
  edit_image: "Edit Image",
};

/**
 * The image cards: what was rendered, shown as the picture itself.
 *
 * The tools write the file into the workspace and report its path, so the card
 * previews it the way a `read` of an image does, with the prompt and the size
 * above it. Until the bytes exist there is nothing to preview: a render takes
 * minutes and the endpoint reports no progress, so the card sweeps instead of
 * sitting on a badge that says "running".
 */
export const imageToolDescriptor: ToolDescriptor = {
  names: ["generate_image", "edit_image"],
  describe(toolCall): ToolCardModel | null {
    const prompt = stringArg(toolCall.args.prompt);
    const title = TITLES[toolCall.name] ?? "Image";

    if (isToolCallInProgress(toolCall)) {
      return {
        icon: toolIcon(toolCall.name),
        title,
        ...(prompt ? { detail: truncate(prompt, MAX_PROMPT) } : {}),
        status: toolStatus(toolCall),
        // The sweep is the answer to "is anything happening", so it is open.
        defaultOpen: true,
        blocks: [{ kind: "rendering", label: renderingLabel(toolCall) }],
      };
    }

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
      icon: toolIcon(toolCall.name),
      title,
      detail: truncate(meta.prompt, MAX_PROMPT),
      status: toolStatus(toolCall, `${meta.width}×${meta.height}`),
      // The picture is what the call was for, so the card opens on it.
      defaultOpen: true,
      blocks,
    };
  },
};

/** What the sweeping tile says the call is doing. */
function renderingLabel(toolCall: ToolCallData): string {
  return toolCall.name === "edit_image" ? "Editing the picture…" : "Rendering the picture…";
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}
