/**
 * The three tools a council member acts with.
 *
 * The room is a shared log, and every tool here is a way of touching it:
 *
 * - `council_post` — the **only** way a member says anything. A member's closing
 *   text at the end of its turn is deliberately not a room message: a model that
 *   ends a turn with an answer has not delivered it, and the room would read a
 *   conversation of half-messages. Posting is a decision, so it is an action.
 * - `council_read` — re-read the room. A member is shown what it missed when it
 *   is woken; this is for everything else.
 * - `council_vote_stop` — end the run on consensus (or on being blocked).
 *
 * The tools talk to the run through `CouncilToolContext` rather than to the
 * database, so the orchestrator owns persistence, wake routing and vote counting
 * while these stay a thin, testable surface over the room.
 */

import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { MAX_MESSAGE_LENGTH } from "./config";
import {
  ALL_HANDLE,
  USER_HANDLE,
  addressesEveryone,
  mentionHelp,
  resolveMentions,
  type MentionTarget,
} from "./mentions";
import type { RoomMessageView } from "./room";

/** Why a member wants to stop — recorded with the vote so the room can read it. */
export type StopVoteKind = "consensus" | "done" | "blocked";

/** A room message as the tools report it — the shared read model. */
export type CouncilRoomMessage = RoomMessageView;

export interface CouncilToolContext {
  /** The member the tools belong to. */
  member: { id: string; name: string };
  /** Every enabled member, for handle validation and error messages. */
  members: readonly MentionTarget[];
  /**
   * Append the message to the room and wake whoever it addresses.
   * Returns the assigned sequence number and the members that were woken.
   */
  post(input: {
    content: string;
    /** Member ids this message addresses. */
    memberIds: string[];
    addressesUser: boolean;
    /** Whether the message addresses every member (`@all`). */
    addressedAll: boolean;
  }): Promise<{ seq: number; wokeNames: string[] }>;
  /** Room messages, oldest first. */
  read(input: {
    sinceSeq?: number;
    limit: number;
    author?: string;
    authorId?: string;
  }): Promise<{ messages: CouncilRoomMessage[]; lastSeq: number }>;
  /** Record this member's stop vote and report the tally. */
  vote(input: {
    reason: string;
    kind: StopVoteKind;
  }): Promise<{ votes: number; needed: number; stopped: boolean }>;
}

/** How many messages `council_read` returns when the caller does not say. */
const READ_DEFAULT_LIMIT = 20;
const READ_MAX_LIMIT = 100;

const postResultSchema = Type.Object({
  posted: Type.Boolean(),
  seq: Type.Integer({ description: "Room sequence number of the message." }),
  woke: Type.Array(Type.String(), {
    description: "Members this message addressed — they now have it in their inbox.",
  }),
  addressedUser: Type.Boolean({ description: "Whether the owner was addressed." }),
});

const readResultSchema = Type.Object({
  count: Type.Integer(),
  lastSeq: Type.Integer({ description: "Sequence number of the newest room message." }),
  messages: Type.Array(
    Type.Object({
      seq: Type.Integer(),
      author: Type.String(),
      authorKind: Type.String({ description: '"user" | "member" | "system"' }),
      addressed: Type.Array(Type.String()),
      content: Type.String(),
    }),
  ),
});

const voteResultSchema = Type.Object({
  voted: Type.Boolean(),
  votes: Type.Integer({ description: "Stop votes recorded so far, including this one." }),
  needed: Type.Integer({ description: "Votes required to end the run." }),
  stopped: Type.Boolean({ description: "Whether the run is now ending." }),
});

/**
 * Build the member's council tools.
 *
 * Every one of them is `direct` exposure (they are the member's whole interface
 * to the room, and a member that has to discover `council_post` in a script
 * cannot collaborate at all).
 */
export function createCouncilTools(context: CouncilToolContext): ToolDefinition[] {
  const { members } = context;

  /** Resolve a name the caller used into a member, or fail with the valid ones. */
  const memberByName = (name: string): MentionTarget => {
    const wanted = name.trim().replace(/^@/, "").toLowerCase();
    const found = members.find((entry) => entry.name.toLowerCase() === wanted);
    if (!found) {
      throw new Error(`No member called "${name}". Address one of: ${mentionHelp(members)}`);
    }
    return found;
  };

  return [
    // ─── council_post ─────────────────────────────────────────────────────

    defineStructuredTool({
      name: "council_post",
      label: "Post to the Room",
      description:
        "Post a message into the council room. This is the ONLY thing the other members and the owner ever see from you — the text you write when you finish your turn is not shown to anyone, so anything you want delivered must be posted here. " +
        `Address a member by writing @name in the message: that is what wakes it and puts your message in its inbox. @${ALL_HANDLE} addresses everyone, @${USER_HANDLE} addresses the owner. ` +
        "Post a finding, a decision, a question or a hand-off, and keep it short; do not narrate your process or repeat what is already in the room.",
      parameters: Type.Object({
        content: Type.String({
          description: "The message. Address members with @name inside it. Markdown is rendered.",
        }),
      }),
      outputSchema: postResultSchema,
      execute: async (_toolCallId, params) => {
        const content = params.content.trim();
        if (!content) {
          throw new Error("A message cannot be empty — post something the others can act on.");
        }
        if (content.length > MAX_MESSAGE_LENGTH) {
          throw new Error(
            `Message is ${content.length} characters; the limit is ${MAX_MESSAGE_LENGTH}. Put the long part in a file and post a summary.`,
          );
        }

        const resolution = resolveMentions(content, members);
        if (resolution.unknown.length > 0) {
          // Refused rather than posted: a message that meant to wake someone and
          // did not is worse than one the author has to rewrite.
          throw new Error(
            `Unknown member${resolution.unknown.length === 1 ? "" : "s"} ${resolution.unknown
              .map((handle) => `@${handle}`)
              .join(", ")}. The members are: ${mentionHelp(members)}`,
          );
        }

        const { seq, wokeNames } = await context.post({
          content,
          memberIds: resolution.memberIds,
          addressesUser: resolution.addressesUser,
          addressedAll: addressesEveryone(content),
        });

        return {
          value: {
            posted: true,
            seq,
            woke: wokeNames,
            addressedUser: resolution.addressesUser,
          },
          text:
            wokeNames.length > 0
              ? `Posted as #${seq}. Woke ${wokeNames.map((name) => `@${name}`).join(", ")}.${
                  resolution.addressesUser ? " The owner was addressed too." : ""
                }`
              : `Posted as #${seq}. Nobody was addressed, so nobody was woken${
                  resolution.addressesUser ? " (the owner was) " : ""
                } — address a member with @name if you need a reply.`,
        };
      },
    }),

    // ─── council_read ─────────────────────────────────────────────────────

    defineStructuredTool({
      name: "council_read",
      label: "Read the Room",
      description:
        "Read the council room, oldest message first. Your turn shows you what was posted since your last turn; use this to look further back, to re-read a message, or to see what a particular member has said.",
      parameters: Type.Object({
        sinceSeq: Type.Optional(
          Type.Integer({
            description:
              "Only messages numbered after this one. Use it to continue where you left off.",
            minimum: 0,
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            description: `How many messages to return, most recent first. Default ${READ_DEFAULT_LIMIT}, maximum ${READ_MAX_LIMIT}.`,
            minimum: 1,
            maximum: READ_MAX_LIMIT,
          }),
        ),
        author: Type.Optional(
          Type.String({ description: "Only messages from this member (its @name)." }),
        ),
      }),
      outputSchema: readResultSchema,
      execute: async (_toolCallId, params) => {
        const author = params.author ? memberByName(params.author) : undefined;
        const limit = Math.min(
          READ_MAX_LIMIT,
          Math.max(1, Math.trunc(params.limit ?? READ_DEFAULT_LIMIT)),
        );

        const { messages, lastSeq } = await context.read({
          ...(params.sinceSeq !== undefined ? { sinceSeq: params.sinceSeq } : {}),
          limit,
          ...(author ? { author: author.name, authorId: author.id } : {}),
        });

        return {
          value: {
            count: messages.length,
            lastSeq,
            messages: messages.map((message) => ({
              seq: message.seq,
              author: message.authorName,
              authorKind: message.authorKind,
              addressed: message.addressedNames,
              content: message.content,
            })),
          },
          text:
            messages.length === 0
              ? "No messages matched."
              : messages.map((m) => `#${m.seq} ${m.authorName}: ${m.content}`).join("\n\n"),
        };
      },
    }),

    // ─── council_vote_stop ───────────────────────────────────────────────

    defineStructuredTool({
      name: "council_vote_stop",
      label: "Vote to Stop",
      description:
        "Vote to end the council run. Use it when the group has reached the goal, has nothing further it can usefully do, or is blocked and needs the owner. The run ends when enough members agree; until then the others keep working, so state your reason for the room to read.",
      parameters: Type.Object({
        reason: Type.String({
          description: "Why the run should end — the others read this and may disagree.",
        }),
        kind: Type.Union(
          [Type.Literal("consensus"), Type.Literal("done"), Type.Literal("blocked")],
          {
            description:
              '"consensus" (the group has agreed), "done" (the work is finished) or "blocked" (it cannot continue without the owner).',
          },
        ),
      }),
      outputSchema: voteResultSchema,
      execute: async (_toolCallId, params) => {
        const reason = params.reason.trim();
        if (!reason) {
          throw new Error("A stop vote needs a reason — the other members read it.");
        }

        const result = await context.vote({ reason, kind: params.kind });

        return {
          value: { voted: true, ...result },
          text: result.stopped
            ? `Vote recorded (${result.votes}/${result.needed}). The run is ending.`
            : `Vote recorded (${result.votes}/${result.needed}). The run continues — the other members have not all agreed.`,
        };
      },
    }),
  ];
}
