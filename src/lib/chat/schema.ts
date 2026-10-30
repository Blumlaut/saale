/**
 * Request bodies for the chat endpoints.
 *
 * An attachment is a chunked upload the composer already staged, so a message
 * carries ids rather than bytes: the files endpoints own the transfer, this only
 * names what to adopt.
 */

import { z } from "zod";

export const sendMessageSchema = z.object({
  content: z.string().optional(),
  attachments: z
    .array(
      z.object({
        uploadId: z.string().min(1),
        fileName: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(255),
        /** 0 is let through so the friendly emptiness check answers. */
        size: z.number().int().nonnegative(),
      }),
    )
    .max(20)
    .optional(),
});
