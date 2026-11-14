/**
 * Which rendered pictures a delete may remove.
 *
 * A render lands in the workspace, which every chat of an account shares, so a
 * picture only goes when nothing else names it: an edit works from a path an
 * earlier chat wrote, and a message that quotes one reads it again.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export interface RenderedImagesToDelete {
  userId: string;
  /** The paths the deleted rows rendered. */
  paths: readonly string[];
  /** The rows that are going away, so they stop counting as references. */
  excluded: { sessionId: string } | { messageId: string };
}

/** The paths among `paths` that no row outside `excluded` mentions. */
export async function renderedImagesToDelete(options: RenderedImagesToDelete): Promise<string[]> {
  const { userId, paths, excluded } = options;
  if (paths.length === 0) return [];

  const where: Prisma.ChatMessageWhereInput = {
    session: { userId },
    NOT: "sessionId" in excluded ? { sessionId: excluded.sessionId } : { id: excluded.messageId },
    OR: paths.flatMap((path) => [
      { toolCalls: { contains: path } },
      { content: { contains: path } },
    ]),
  };
  const elsewhere = await prisma.chatMessage.findMany({
    where,
    select: { content: true, toolCalls: true },
  });
  const mentioned = elsewhere.map((m) => `${m.content}\n${m.toolCalls ?? ""}`).join("\n");

  return paths.filter((path) => !mentioned.includes(path));
}
