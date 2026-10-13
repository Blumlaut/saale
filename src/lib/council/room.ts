/**
 * The room's read model.
 *
 * One shape for a room message as everything outside the database sees it — the
 * member tools, the turn prompt, the run loop and the room UI. A stored row has
 * more than this (ids, run bookkeeping, timestamps); readers get exactly these
 * fields, with mentions already resolved to names, because a name is what a
 * message displays and what a member is addressed by.
 *
 * Pure — no database or Node-only imports.
 */

/** Who wrote a room message. */
export type RoomAuthorKind = "user" | "member" | "system";

export interface RoomMessageView {
  /** Monotonic within the council: the room's order and every reader's cursor. */
  seq: number;
  /** The authoring member, absent for the owner and for system notices. */
  memberId: string | null;
  authorName: string;
  authorKind: RoomAuthorKind;
  content: string;
  /**
   * Members this message addressed, by name, plus the owner's handle when the
   * message addressed them. Names rather than ids: a renamed or removed member
   * still reads correctly in the transcript.
   */
  addressedNames: string[];
}
