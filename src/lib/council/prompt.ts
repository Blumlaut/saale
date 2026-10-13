/**
 * What a council member is told.
 *
 * Two prompts per member: a **system prompt** describing the room and the
 * member's place in it, written once per session, and a **turn prompt** — the
 * user message of each turn — carrying what the member missed since its last
 * one. The split matters: the system prompt is replayed from the transcript on
 * every request, so anything that grows per turn belongs in the turn prompt.
 *
 * The one rule both prompts repeat is that the room only sees what the member
 * sends with `council_post`. A model's instinct is to end its turn with an
 * answer, and an unposted answer reaches nobody — so it is stated in the system
 * prompt, in the tool description and in every turn prompt.
 *
 * Pure — no database or SDK imports, so the wording is unit-testable.
 */

import type { CouncilOrchestration, StopVoteThreshold } from "./config";
import { TRANSCRIPT_MAX_CHARS, TRANSCRIPT_WINDOW } from "./config";
import { ALL_HANDLE, USER_HANDLE } from "./mentions";
import type { RoomMessageView } from "./room";

export interface CouncilMemberSummary {
  name: string;
  /** The member's stated role, if it has one. */
  instructions?: string | null;
}

export interface CouncilPromptContext {
  councilName: string;
  brief: string;
  member: CouncilMemberSummary;
  /** Every enabled member, including this one. */
  members: CouncilMemberSummary[];
  orchestration: CouncilOrchestration;
  stopVoteThreshold: StopVoteThreshold;
  /** Votes needed to stop a run — resolved by the caller from the threshold. */
  stopVoteQuorum: number;
  /** The member's workspace, or null when the sandbox is unavailable. */
  sandboxPath: string | null;
}

/** How a run stops, in the member's terms. */
function quorumSentence(threshold: StopVoteThreshold, quorum: number): string {
  switch (threshold) {
    case "any":
      return "a single vote to stop ends the run";
    case "unanimous":
      return `all ${quorum} members must vote to stop`;
    case "majority":
      return `${quorum} of the members must vote to stop`;
  }
}

/** How members take turns, in the member's terms. */
function turnSentence(orchestration: CouncilOrchestration): string {
  return orchestration === "round-robin"
    ? "You take one turn per round, in the order the members are listed; the others take theirs one at a time."
    : "You run when someone addresses you in a message, or when the owner speaks. The other members run at the same time as you when they are addressed too.";
}

/** The system prompt for one member, for the whole run. */
export function buildCouncilMemberPrompt(context: CouncilPromptContext): string {
  const { member, members, brief, councilName } = context;

  const others = members.filter((entry) => entry.name !== member.name);
  const roster = others.map((entry) => `@${entry.name}`).join(", ");

  const sections = [
    `You are ${member.name}, one member of "${councilName}" — a small group of agents working one problem together in a shared room. Each member has its own model and its own reasoning; the room is where you act together.`,

    `The council's goal:\n${brief}`,

    member.instructions?.trim()
      ? `Your role in this council:\n${member.instructions.trim()}`
      : null,

    `The members are ${roster ? `${roster} and you` : "you alone"}. Address a member by writing its @name in a message — that is what wakes it, and it is the only thing that does. @${ALL_HANDLE} addresses everyone and @${USER_HANDLE} addresses the human owner of this council. Nothing else reaches another member.`,

    `How the room works:
- The room only sees what you send with \`council_post\`. Your closing text at the end of a turn is **not** shown to anyone — it is kept privately for the owner to inspect. An answer you did not post was not delivered.
- Post when you have something the others need: a finding, a decision, a question, a file you wrote. Do not narrate your process.
- ${turnSentence(context.orchestration)}
- Re-read the room with \`council_read\` whenever you need context you were not shown.
- When the goal is met, or the group is blocked, call \`council_vote_stop\` with your reason. ${quorumSentence(context.stopVoteThreshold, context.stopVoteQuorum)}. Do not vote to stop while there is work you can still do yourself.
- Address the owner with @${USER_HANDLE} when the group needs a decision only they can make; that pauses the run.`,

    `Working together:
- You share one private workspace with the other members${context.sandboxPath ? `: \`${context.sandboxPath}\`` : ""}. It is separate from the owner's own files — neither can read the other, and the owner cannot see what is in it unless you paste it into a message.
- Work there with the file tools. Files are shared with the other members immediately, so say which file you changed when you post about it.
- Announce a file before you rewrite it: another member may be working in it at the same time.
- Keep posts short and specific. Long output belongs in a file, summarized in the post.`,

    `Be a colleague, not an assistant: disagree when you think the group is wrong, say what you are unsure of, and build on what the others posted rather than restating it.`,
  ];

  return sections.filter((section): section is string => section !== null).join("\n\n");
}

/** One room message as a turn prompt shows it — the shared read model. */
export type TurnMessage = RoomMessageView;

export interface TurnSelection {
  messages: TurnMessage[];
  /** How many older messages were left out, so the member can read them on request. */
  droppedEarlier: number;
}

/**
 * Choose the messages a turn prompt carries: the newest in the window, capped by
 * characters as well as by count.
 *
 * Count alone is not a bound on size — messages may be thousands of characters
 * each, and a council whose transcript is long would spend its whole context on
 * room history. One message is always kept, however long, so a turn is never
 * prompted with nothing.
 */
export function selectTurnMessages(
  messages: readonly TurnMessage[],
  limit: number = TRANSCRIPT_WINDOW,
  maxChars: number = TRANSCRIPT_MAX_CHARS,
): TurnSelection {
  const recent = messages.slice(-limit);
  const kept: TurnMessage[] = [];
  let used = 0;

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const message = recent[i]!;
    const size = message.content.length;
    if (kept.length > 0 && used + size > maxChars) break;
    kept.unshift(message);
    used += size;
  }

  return { messages: kept, droppedEarlier: messages.length - kept.length };
}

function describeMessage(message: TurnMessage): string {
  const author =
    message.authorKind === "user"
      ? `${message.authorName} (the owner)`
      : message.authorKind === "system"
        ? "system"
        : message.authorName;
  const addressed =
    message.addressedNames.length > 0 ? ` → ${message.addressedNames.join(", ")}` : "";
  return `#${message.seq} ${author}${addressed}:\n${message.content}`;
}

export interface TurnPromptOptions {
  memberName: string;
  messages: readonly TurnMessage[];
  /** Whether this member was addressed by those messages. */
  addressed: boolean;
  /** Round number, in round-robin mode. */
  round?: number | undefined;
  /** The member's workspace path, or null when it has none. */
  sandboxPath?: string | null;
  /**
   * Older messages the caller did not fetch (the room is longer than the window
   * it read). Counted together with what the char cap drops, so the prompt never
   * implies the member has seen the whole room.
   */
  droppedBefore?: number;
}

/**
 * The user message of one turn.
 *
 * It restates the posting rule because it is the rule models break: the model
 * has been handed a conversation and its reflex is to answer it as text.
 */
export function buildCouncilTurnPrompt(options: TurnPromptOptions): string {
  const { memberName, messages, addressed } = options;
  const selection = selectTurnMessages(messages);

  const situation =
    options.round !== undefined
      ? `It is your turn in round ${options.round}.`
      : addressed
        ? "You were addressed, and someone is waiting on your answer."
        : "You have been woken: the room moved on and these messages involve you.";

  const body = selection.messages.map(describeMessage).join("\n\n");
  const droppedCount = selection.droppedEarlier + (options.droppedBefore ?? 0);
  const dropped =
    droppedCount > 0
      ? `${droppedCount} older message${droppedCount === 1 ? "" : "s"} in the room ${droppedCount === 1 ? "is" : "are"} not shown — use \`council_read\` if you need ${droppedCount === 1 ? "it" : "them"}.`
      : null;

  return [
    situation,
    `Messages posted since your last turn${dropped ? ` (${dropped})` : ""}:`,
    body || "(nothing new)",
    `\nNow act as ${memberName}. Post with \`council_post\` if you have something to say — remember that the others cannot see anything else you write, including your closing text.${options.sandboxPath ? ` Your workspace is \`${options.sandboxPath}\`.` : ""}`,
  ].join("\n\n");
}
