import { Hash, Image as ImageIcon } from "lucide-react";
import { plural, truncatePath } from "@/lib/format";
import { toolIcon } from "@/lib/pi/tool-infos";
import { diffEdits, lineCount, type TextEdit } from "./diff-text";
import { isToolCallInProgress, toolStatus } from "../tool-status";
import type { ToolCardBlock, ToolCardModel, ToolDescriptor, ToolFact } from "../tool-card-model";
import type { ToolCallData } from "../types";

/** Longest path shown beside a tool's name. */
const MAX_PATH = 48;
/** Diff lines shown before the card reports the rest. */
const MAX_DIFF = 60;
/** Characters of file content shown before truncating. */
const MAX_CONTENT = 2000;

/**
 * The file tools: read, write and edit.
 *
 * Their arguments are the whole call (a path, and the text read or written),
 * so the generic card spends its body printing them back. These cards move the
 * path into the header and show what the call did to the file: the diff of an
 * edit, the content of a write, the contents a read returned.
 */
export const fileToolDescriptor: ToolDescriptor = {
  names: ["read", "write", "edit"],
  describe(toolCall) {
    const path = stringArg(toolCall.args.path);
    if (!path) return null;
    // A failure's reason is the point of the card, so it keeps the generic
    // card's arguments and error together rather than a diff that did not land.
    if (toolCall.error || toolCall.status === "error") return null;

    switch (toolCall.name) {
      case "edit":
        return describeEdit(toolCall, path);
      case "write":
        return describeWrite(toolCall, path);
      default:
        return describeRead(toolCall, path);
    }
  },
};

function describeEdit(toolCall: ToolCallData, path: string): ToolCardModel | null {
  const edits = readEdits(toolCall.args.edits);
  if (edits.length === 0) return null;

  return {
    icon: toolIcon(toolCall.name),
    title: "Edit",
    detail: truncatePath(path, MAX_PATH),
    status: toolStatus(toolCall, finishedLabel(toolCall, plural(edits.length, "edit", "edits"))),
    blocks: [{ kind: "diff", lines: diffEdits(edits), max: MAX_DIFF }],
  };
}

function describeWrite(toolCall: ToolCallData, path: string): ToolCardModel {
  const content = stringArg(toolCall.args.content);
  const lines = lineCount(content);

  return {
    icon: toolIcon(toolCall.name),
    title: "Write",
    detail: truncatePath(path, MAX_PATH),
    status: toolStatus(
      toolCall,
      finishedLabel(toolCall, lines > 0 ? plural(lines, "line", "lines") : "empty file"),
    ),
    blocks: content ? [{ kind: "code", text: content, label: "Contents", max: MAX_CONTENT }] : [],
  };
}

function describeRead(toolCall: ToolCallData, path: string): ToolCardModel {
  const blocks: ToolCardBlock[] = [];
  const image = imageMimeType(toolCall.result);
  const facts = image ? [{ icon: ImageIcon, text: image }] : readRange(toolCall.args);
  if (facts.length > 0) blocks.push({ kind: "facts", items: facts });

  if (image) {
    // A read of an image shows the model's view of it, which is the whole call.
    blocks.push({ kind: "image", path });
  } else if (toolCall.result) {
    blocks.push({ kind: "code", text: toolCall.result, label: "Contents", max: MAX_CONTENT });
  }

  return {
    icon: toolIcon(toolCall.name),
    title: "Read",
    detail: truncatePath(path, MAX_PATH),
    status: toolStatus(toolCall),
    blocks,
  };
}

/** The MIME type of an image a read returned, taken from the notice it opens with. */
function imageMimeType(result: string | undefined): string | undefined {
  return /^Read image file \[([^\]]+)\]/.exec(result ?? "")?.[1];
}

/** The window a read asked for, when it asked for one. */
function readRange(args: Record<string, unknown>): ToolFact[] {
  const facts: ToolFact[] = [];
  const offset = numberArg(args.offset);
  if (offset !== undefined && offset > 1) {
    facts.push({ icon: Hash, text: `from line ${offset}` });
  }
  const limit = numberArg(args.limit);
  if (limit !== undefined) {
    facts.push({ icon: Hash, text: plural(limit, "line", "lines") });
  }
  return facts;
}

/** A count of what the call did, or nothing while it is still doing it. */
function finishedLabel(toolCall: ToolCallData, label: string): string | undefined {
  return isToolCallInProgress(toolCall) ? undefined : label;
}

function readEdits(value: unknown): TextEdit[] {
  if (!Array.isArray(value)) return [];
  const edits: TextEdit[] = [];
  for (const edit of value) {
    if (typeof edit !== "object" || edit === null) continue;
    const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown };
    if (typeof oldText === "string" && typeof newText === "string")
      edits.push({ oldText, newText });
  }
  return edits;
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
