/**
 * Getting the composer's files into the workspace.
 *
 * Both things the composer sends. a message and a command that works from
 * files. stage the same way: one chunked upload per file, then ids in the
 * request, so a large attachment never passes through the request body.
 */

import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_IMAGE_BYTES,
  isImageMime,
} from "@/lib/chat/attachment-limits";
import {
  discardStagedUpload,
  stageFile,
  type StagedFile,
  type UploadProgress,
} from "@/lib/files/upload-client";
import { formatFileSize } from "@/lib/utils";

/** The ceiling for one attachment: images are re-encoded, everything else moves. */
export function oversizedFile(file: File): string | null {
  const ceiling = isImageMime(file.type) ? MAX_CHAT_IMAGE_BYTES : MAX_CHAT_FILE_BYTES;
  if (file.size === 0) return `${file.name} is empty`;
  if (file.size > ceiling) {
    return `${file.name} is ${formatFileSize(file.size)}. Max: ${formatFileSize(ceiling)}`;
  }
  return null;
}

/** Drop staged bytes the request will not use. */
export async function discardStaged(staged: readonly StagedFile[]): Promise<void> {
  for (const file of staged) await discardStagedUpload("user", file.uploadId);
}

export type StageOutcome = { ok: true; staged: StagedFile[] } | { ok: false; message: string };

/** Stage every file in the user's workspace, reporting bytes as they land. */
export async function stageAttachments(
  files: readonly File[],
  options: {
    signal?: AbortSignal | undefined;
    onProgress?: ((p: UploadProgress | null) => void) | undefined;
  },
): Promise<StageOutcome> {
  if (files.length > MAX_CHAT_ATTACHMENTS) {
    return { ok: false, message: `Attach at most ${MAX_CHAT_ATTACHMENTS} files at a time` };
  }

  const staged: StagedFile[] = [];
  try {
    for (const [position, file] of files.entries()) {
      const refusal = oversizedFile(file);
      if (refusal) {
        await discardStaged(staged);
        return { ok: false, message: refusal };
      }

      const result = await stageFile(file, {
        target: "user",
        // The id is all a request needs; there is no destination folder.
        dir: "",
        batch: { index: position + 1, count: files.length },
        onProgress: options.onProgress ?? undefined,
        signal: options.signal,
      });
      if (!result.ok) {
        await discardStaged(staged);
        return { ok: false, message: result.message };
      }
      staged.push(result.staged);
    }
  } finally {
    options.onProgress?.(null);
  }

  return { ok: true, staged };
}
