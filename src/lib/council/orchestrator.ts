/**
 * The run loop.
 *
 * A council is a room with a goal and a set of members; the loop's whole job is
 * to decide **who runs next** and to stop. It owns no database handle and no
 * model: the store, the session factory, the clock and the event sink all arrive
 * as `CouncilRunDeps`, which is what makes the scheduling — the part worth
 * getting right — testable without a container, a provider or a database.
 *
 * Two modes, one stop condition:
 *
 * - **parallel** (the default): every member whose inbox is non-empty runs at
 *   once. A member's inbox is filled by the messages that address it, so the
 *   conversation graph decides the schedule and no member waits on another. A
 *   member that is addressed while working is not made to wait for its turn to
 *   finish on its own: at the next tool-call boundary the turn is ended
 *   (recorded as `preempted`) and the member is re-run on the message.
 *
 * In round-robin a busy member can never be addressed mid-turn (no other member
 * is running to post, and the owner's messages are absorbed between rounds), so
 * preemption is a parallel-mode concern only.
 * - **round-robin**: one member at a time, in list order, round after round.
 *
 * Members speak only through `council_post` (their closing text is not a room
 * message — see `tools.ts`), so every wake in this file comes from a message
 * that was actually delivered.
 *
 * The loop stops on the first of:
 * - a stop vote reaching quorum (`consensus`)
 * - a member addressing the owner (`user-question` — the run pauses)
 * - the owner or the watchdog asking it to stop (`aborted`)
 * - a budget (wall clock, tokens, cost)
 * - nothing left to do: nobody addressed and nobody running (`no-pending-work`).
 *
 * A member's turn failing does **not** stop the run: it is recorded on the turn,
 * announced in the room, and the other members carry on. A run in which every
 * turn fails ends on its own, because a failed turn wakes nobody.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentIdleTimeout, DEFAULT_AGENT_IDLE_TIMEOUT_MS } from "@/lib/pi/agent-idle-timeout";
import { buildFinalAssistantMessage, extractThinking } from "@/lib/pi/stream-logic";
import type { ToolConfig, ToolExposureConfig } from "@/lib/pi/tool-categories";
import {
  ABORT_POLL_MS,
  HEARTBEAT_MS,
  ROOM_ABSORB_LIMIT,
  TRANSCRIPT_WINDOW,
  stopVoteQuorum,
  type CouncilOrchestration,
  type RunBudget,
  type StopVoteThreshold,
} from "./config";
import { ALL_HANDLE, USER_HANDLE, type MentionTarget } from "./mentions";
import { buildCouncilTurnPrompt } from "./prompt";
import type { RoomMessageView } from "./room";
import type { createCouncilMemberSession } from "./session";
import { type CouncilMemberConfig, type CouncilMemberSession } from "./session";
import type { CouncilToolContext, StopVoteKind } from "./tools";

/** Why a run ended. Stored on `CouncilRun.stopReason`. */
export type StopReason =
  | "consensus"
  | "no-pending-work"
  | "budget:time"
  | "budget:tokens"
  | "budget:cost"
  | "aborted"
  | "user-question"
  | "no-members"
  | "error";

export interface CouncilMemberPlan extends CouncilMemberConfig {
  enabled: boolean;
}

/** Everything the loop needs to know about the run it is executing. */
export interface CouncilRunPlan {
  councilId: string;
  userId: string;
  runId: string;
  councilName: string;
  brief: string;
  orchestration: CouncilOrchestration;
  stopVoteThreshold: StopVoteThreshold;
  budget: RunBudget;
  /** The council's tool selection; a member's own overrides it. */
  toolConfig: ToolConfig | null;
  toolExposure: ToolExposureConfig | null;
  sandboxKey: string;
  members: CouncilMemberPlan[];
  /** Members the opening message addressed. Null wakes every enabled member. */
  openingMemberIds: string[] | null;
  /**
   * The room's newest seq when the run began.
   *
   * Everything above it was either the opening message (already routed from
   * `openingMemberIds`) or older history; everything below it arrives while the
   * loop is running and is absorbed by `absorbExternalMessages`.
   */
  startedAfterSeq: number;
}

/** A member's turn, as the store persists it. */
export interface TurnRecord {
  /**
   * `preempted`: the turn was ended at a tool-call boundary because a message
   * addressed the member mid-turn — not a failure, and not a finished answer.
   */
  status: "completed" | "preempted" | "error";
  thinking: string | null;
  toolCalls: string | null;
  finalText: string | null;
  postedSeqs: number[];
  inputTokens: number;
  outputTokens: number;
  cost: number;
  error?: string | null;
}

export interface RunProgress {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  turnCount: number;
}

/**
 * What the loop does to the room and the run record.
 *
 * Deliberately narrow: the loop never holds a Prisma client, so its scheduling
 * can be tested against a fake room.
 */
export interface CouncilRunStore {
  postMessage(input: {
    authorKind: "user" | "member" | "system";
    memberId?: string | null;
    authorName: string;
    content: string;
    mentions: string[];
  }): Promise<RoomMessageView>;
  /** Newest `limit` messages after `afterSeq`, plus how many were skipped. */
  messageWindow(input: {
    afterSeq: number;
    limit: number;
  }): Promise<{ messages: RoomMessageView[]; skippedBefore: number }>;
  /** Messages after `afterSeq`, oldest first — what `council_read` returns. */
  messagesAfter(input: {
    afterSeq: number;
    limit: number;
    memberId?: string;
  }): Promise<RoomMessageView[]>;
  startTurn(input: {
    memberId: string;
    memberName: string;
    triggeredBy: number[];
    seenThrough: number | null;
  }): Promise<string>;
  finishTurn(turnId: string, data: TurnRecord): Promise<void>;
  /** Heartbeat + running totals, so a dead loop is detectable. */
  progress(progress: RunProgress): Promise<void>;
}

export interface CouncilRunDeps {
  store: CouncilRunStore;
  createSession: typeof createCouncilMemberSession;
  /** Publish a room event; never throws. */
  publish: (event: string, data: unknown) => Promise<void>;
  /** Milliseconds since the epoch (injectable so budgets are testable). */
  now: () => number;
  /** Whether the owner or the watchdog asked this run to stop. */
  isAbortRequested: () => Promise<boolean>;
  /** How often an in-flight turn checks for a stop (test seam). */
  abortPollMs?: number;
  /** How long a turn may be silent before it is treated as stalled (test seam). */
  turnIdleTimeoutMs?: number;
}

export interface CouncilRunOutcome {
  stopReason: StopReason;
  /** Set when the run ended on an error (a sandbox that would not start, …). */
  error: string | null;
  /** True when the run paused on a question addressed to the owner. */
  awaitingUser: boolean;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/** How often a member's live thinking is published, per turn. */
const THINKING_PUBLISH_INTERVAL_MS = 250;

/**
 * The inbox marker the opening wake uses.
 *
 * The room's own numbering starts at 1, so this is not a message and is never
 * recorded as one: it only puts the member in the scheduler's queue. See
 * `wakeReasons`.
 */
const OPENING_SEQ = 0;

interface MemberState {
  plan: CouncilMemberPlan;
  /** Message seqs that woke this member and have not been consumed yet. */
  inbox: number[];
  /** Highest room seq the member has been shown — its read cursor. */
  cursor: number;
  session: CouncilMemberSession | null;
  /**
   * Set *before* the turn starts and cleared when it settles.
   *
   * The flag is raised synchronously rather than derived from the turn's
   * promise: a promise that settles before it is stored would leave a
   * never-cleared reference behind, and the scheduler would wait forever on a
   * turn that already finished.
   */
  busy: boolean;
  turns: number;
  /** Cumulative session stats at the previous turn's end, for deltas. */
  stats: { inputTokens: number; outputTokens: number; cost: number };
  /** Where a turn's posts are recorded while it runs. */
  posted: { seqs: number[] };
}

interface TurnOutcome {
  posted: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one council until it stops.
 *
 * Resolves with the outcome; the caller owns the run record and the council's
 * status. Everything the loop announces mid-run goes through `deps.publish`.
 */
export async function runCouncilLoop(
  plan: CouncilRunPlan,
  deps: CouncilRunDeps,
): Promise<CouncilRunOutcome> {
  const participants = plan.members.filter((member) => member.enabled);
  const quorum = stopVoteQuorum(plan.stopVoteThreshold, participants.length);
  const deadline =
    plan.budget.maxDurationSeconds === null
      ? null
      : deps.now() + plan.budget.maxDurationSeconds * 1000;

  const states = new Map<string, MemberState>(
    participants.map((member) => [
      member.id,
      {
        plan: member,
        inbox: [],
        cursor: 0,
        session: null,
        busy: false,
        turns: 0,
        stats: { inputTokens: 0, outputTokens: 0, cost: 0 },
        posted: { seqs: [] },
      },
    ]),
  );
  /** Turns still in flight, so the loop can wait for the ones it abandoned. */
  const inFlight = new Set<Promise<TurnOutcome>>();
  const targets: MentionTarget[] = participants.map((member) => ({
    id: member.id,
    name: member.name,
  }));

  const votes = new Map<string, { reason: string; kind: StopVoteKind }>();
  const totals = { inputTokens: 0, outputTokens: 0, cost: 0, turnCount: 0 };
  let stop: { reason: StopReason; error?: string } | null = null;
  let awaitingUser = false;
  /**
   * True once the run is being torn down rather than merely pausing.
   *
   * A hard stop ends the run, so a turn still unwinding must not post into a
   * room nobody is following any more. A consensus stop is different: the
   * in-flight turns are deliberately left to finish and post (their work is
   * already paid for), so this is not simply `stop !== null`.
   */
  let halted = false;

  /** Wake a member: its inbox holds the seqs that addressed it. */
  const wake = (memberId: string, seq: number) => {
    const state = states.get(memberId);
    if (!state || state.inbox.includes(seq)) return;
    state.inbox.push(seq);
  };

  /**
   * The inbox as the turn's record shows it: real room messages only.
   *
   * The opening wake carries no message of its own, so it is dropped — an entry
   * the room cannot resolve would render as a message that does not exist.
   */
  const wakeReasons = (inbox: readonly number[]): number[] =>
    inbox.filter((seq) => seq !== OPENING_SEQ);

  /** Room messages the loop did not post itself — i.e. the owner speaking. */
  let externalCursor = plan.startedAfterSeq;

  /**
   * Wake whoever the owner addressed while the run was working.
   *
   * A running loop schedules from its in-memory inboxes, and the owner posts
   * straight to the database, so without this a message typed into a working
   * room would be read by nobody: the room would look like it ignored its owner.
   * A message that addresses nobody wakes everyone — the owner addressing the
   * room is talking to all of it.
   */
  const absorbExternalMessages = async (): Promise<void> => {
    const window = await deps.store
      .messageWindow({ afterSeq: externalCursor, limit: ROOM_ABSORB_LIMIT })
      .catch((err) => {
        console.error(`[council:${plan.runId}] Could not check the room for new messages:`, err);
        return { messages: [], skippedBefore: 0 };
      });

    for (const message of window.messages) {
      externalCursor = Math.max(externalCursor, message.seq);
      // Members' posts were routed by `post`; notices address nobody.
      if (message.authorKind !== "user") continue;

      const named = participants.filter((member) =>
        message.addressedNames.some((name) => name.toLowerCase() === member.name.toLowerCase()),
      );
      const everyone = message.addressedNames.includes(ALL_HANDLE) || named.length === 0;
      for (const member of everyone ? participants : named) wake(member.id, message.seq);
    }
  };

  const postSystem = async (content: string) => {
    const message = await deps.store.postMessage({
      authorKind: "system",
      authorName: "council",
      content,
      mentions: [],
    });
    await deps.publish("notice", message);
    return message;
  };

  /** Stop the run, aborting whatever is in flight when asked to. */
  const requestStop = (reason: StopReason, abort: boolean, error?: string) => {
    stop = { reason, ...(error ? { error } : {}) };
    if (abort) {
      halted = true;
      abortAll();
    }
  };

  /** Request one member's abort, logging a failure instead of blocking on it. */
  const abortSession = (state: MemberState) => {
    const session = state.session?.session;
    if (!session) return;
    void Promise.resolve(session.abort()).catch((err) => {
      console.error(`[council:${plan.runId}] Failed to abort ${state.plan.name}:`, err);
    });
  };

  /**
   * Ask every live member to stop, without waiting for any of them to become
   * idle.
   *
   * `AgentSession.abort()` resolves only once the agent is idle, and a turn can
   * stay busy far longer than the stop that ends it: a tool that ignores the
   * abort signal, or a provider whose stream never closes after the server it
   * was talking to went away, keeps `waitForIdle()` pending indefinitely.
   * Awaiting that is what stranded the run — the loop sat in `abortAll` while
   * the heartbeat kept the watchdog away, so neither Stop nor the wall-clock
   * budget could ever land. The run has already decided to stop; the abort is
   * requested and left to take effect on its own.
   */
  const abortAll = () => {
    for (const state of states.values()) abortSession(state);
  };

  // ─── The member's view of the room: what its tools act on ──────────────────

  function toolContext(state: MemberState): CouncilToolContext {
    return {
      member: { id: state.plan.id, name: state.plan.name },
      members: targets,

      post: async ({ content, memberIds, addressesUser, addressedAll }) => {
        // The run is over: a tool call that is still unwinding (a call the
        // abort could not interrupt) must not append to a room nobody is
        // following any more.
        if (halted) {
          throw new Error("The run was stopped, so this post was not delivered.");
        }
        // Mentions are stored as names: the transcript renders without a join and
        // survives a member being renamed or removed.
        const mentioned = participants
          .filter((member) => memberIds.includes(member.id))
          .map((member) => member.name);
        const mentions = [
          ...(addressedAll ? [ALL_HANDLE] : []),
          ...mentioned,
          ...(addressesUser ? [USER_HANDLE] : []),
        ];

        const message = await deps.store.postMessage({
          authorKind: "member",
          memberId: state.plan.id,
          authorName: state.plan.name,
          content,
          mentions,
        });
        state.posted.seqs.push(message.seq);
        await deps.publish("message", message);

        // Who this woke: everyone for @all, the named members otherwise — never
        // the author, so a member cannot put itself in a loop.
        const woke = (
          addressedAll ? participants : participants.filter((m) => memberIds.includes(m.id))
        ).filter((member) => member.id !== state.plan.id);
        for (const member of woke) wake(member.id, message.seq);

        if (addressesUser) awaitingUser = true;

        return { seq: message.seq, wokeNames: woke.map((member) => member.name) };
      },

      read: async ({ sinceSeq, limit, authorId }) => {
        const messages = await deps.store.messagesAfter({
          afterSeq: sinceSeq ?? 0,
          limit,
          ...(authorId ? { memberId: authorId } : {}),
        });
        return {
          messages,
          lastSeq: messages.at(-1)?.seq ?? sinceSeq ?? 0,
        };
      },

      vote: async ({ reason, kind }) => {
        votes.set(state.plan.id, { reason, kind });
        await postSystem(`@${state.plan.name} votes to stop (${kind}): ${reason}`);

        if (votes.size >= quorum && !stop) {
          await postSystem(
            `The council is stopping: ${votes.size} of ${quorum} required vote${quorum === 1 ? "" : "s"} to stop.`,
          );
          // In-flight turns are left to finish: their work is already paid for
          // and a half-written post would be lost.
          stop = { reason: "consensus" };
        }

        return { votes: votes.size, needed: quorum, stopped: votes.size >= quorum };
      },
    };
  }

  // ─── One member's turn ────────────────────────────────────────────────────

  async function ensureSession(state: MemberState): Promise<CouncilMemberSession> {
    if (state.session) return state.session;
    state.session = await deps.createSession({
      userId: plan.userId,
      councilId: plan.councilId,
      councilName: plan.councilName,
      brief: plan.brief,
      orchestration: plan.orchestration,
      stopVoteThreshold: plan.stopVoteThreshold,
      members: participants.map((member) => ({
        name: member.name,
        instructions: member.instructions,
      })),
      memberTargets: targets,
      member: {
        id: state.plan.id,
        name: state.plan.name,
        instructions: state.plan.instructions,
        modelProvider: state.plan.modelProvider,
        modelName: state.plan.modelName,
        thinkingLevel: state.plan.thinkingLevel,
        toolConfig: state.plan.toolConfig,
      },
      councilToolConfig: plan.toolConfig,
      toolExposure: plan.toolExposure,
      sandboxKey: plan.sandboxKey,
      toolContext: toolContext(state),
    });
    return state.session;
  }

  /**
   * Prompt the member once and record what it did.
   *
   * Never throws: a member that fails is a turn with an error, not the end of
   * the run.
   */
  async function runTurn(state: MemberState, round: number | undefined): Promise<TurnOutcome> {
    const inbox = state.inbox.splice(0, state.inbox.length);
    state.posted = { seqs: [] };

    let session: CouncilMemberSession;
    try {
      session = await ensureSession(state);
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[council:${plan.runId}] ${state.plan.name} could not start:`, err);
      await deps.store.finishTurn(
        await deps.store.startTurn({
          memberId: state.plan.id,
          memberName: state.plan.name,
          triggeredBy: wakeReasons(inbox),
          seenThrough: null,
        }),
        {
          status: "error",
          thinking: null,
          toolCalls: null,
          finalText: null,
          postedSeqs: [],
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          error: message,
        },
      );
      await postSystem(`@${state.plan.name} could not start: ${message}`);
      return { posted: 0 };
    }

    const window = await deps.store
      .messageWindow({ afterSeq: state.cursor, limit: TRANSCRIPT_WINDOW })
      .catch(async (err) => {
        console.error(
          `[council:${plan.runId}] Could not read the room for ${state.plan.name}:`,
          err,
        );
        return { messages: [], skippedBefore: 0 };
      });
    const seenThrough = window.messages.at(-1)?.seq ?? null;
    if (seenThrough !== null) state.cursor = Math.max(state.cursor, seenThrough);

    const prompt = buildCouncilTurnPrompt({
      memberName: state.plan.name,
      messages: window.messages,
      addressed: inbox.length > 0,
      round,
      sandboxPath: session.sandbox.home,
      droppedBefore: window.skippedBefore,
    });

    const triggeredBy = wakeReasons(inbox);
    const turnId = await deps.store.startTurn({
      memberId: state.plan.id,
      memberName: state.plan.name,
      triggeredBy,
      seenThrough,
    });
    await deps.publish("turn_started", {
      turnId,
      memberId: state.plan.id,
      memberName: state.plan.name,
      triggeredBy,
      addressed: inbox.length > 0,
      round: round ?? null,
    });

    // A message that addresses this member while it works should not wait for
    // the turn to run to its own conclusion. The watch fires on the next
    // tool-call boundary (see collectTurn's onToolEnd): the in-flight tool call
    // is left to finish, and only then does the turn end, so a preemption never
    // leaves a half-executed call behind.
    let preempted = false;
    const preempt: { watch: StopWatch; trigger: () => void } | null =
      plan.orchestration === "parallel"
        ? (() => {
            let rejectPreempt: (err: Error) => void = () => {};
            const watch: StopWatch = {
              promise: new Promise<never>((_resolve, reject) => {
                rejectPreempt = reject;
              }),
              cancel: () => {},
            };
            return {
              watch,
              trigger: () => {
                preempted = true;
                abortSession(state);
                rejectPreempt(new Error("Turn ended early: this member was addressed again."));
              },
            };
          })()
        : null;

    const collector = collectTurn(session.session, state, deps, () => {
      // `!preempted` keeps a second tool end from aborting an already-ending turn.
      if (preempt && !stop && !preempted && state.inbox.length > 0) preempt.trigger();
    });
    const before = state.stats;
    let failure: string | null = null;

    try {
      await raceWithStops(session.session.prompt(prompt, { expandPromptTemplates: false }), [
        deadlineWatch(deadline === null ? null : deadline - deps.now(), () =>
          requestStop("budget:time", true),
        ),
        abortWatch(deps, () => requestStop("aborted", true)),
        // A stalled turn is this member's failure, not the run's end: the other
        // members may be working fine, and a run in which every turn stalls
        // ends on its own once no turn wakes anybody.
        idleWatch(
          session.session,
          deps.turnIdleTimeoutMs ?? DEFAULT_AGENT_IDLE_TIMEOUT_MS,
          `council:${plan.runId}:${state.plan.name}`,
          () => abortSession(state),
        ),
        preempt?.watch ?? null,
      ]);
    } catch (err) {
      // A preemption is not a failure: the turn ended early on purpose so the
      // member can answer the message that addressed it. It is recorded below
      // as `preempted`, with its partial transcript and usage.
      if (preempted && !stop) {
        // no error to record
      } else {
        failure = errorMessage(err);
        console.error(`[council:${plan.runId}] ${state.plan.name}'s turn failed:`, err);
      }
    } finally {
      collector.stop();
    }

    const transcript = collector.snapshot();
    const stats = readStats(session.session, plan.runId);
    // A session whose stats cannot be read keeps the previous baseline: treating
    // the failure as zeros would make the next turn count the whole session's
    // usage again.
    const delta = stats
      ? {
          inputTokens: Math.max(0, stats.inputTokens - before.inputTokens),
          outputTokens: Math.max(0, stats.outputTokens - before.outputTokens),
          cost: Math.max(0, stats.cost - before.cost),
        }
      : { inputTokens: 0, outputTokens: 0, cost: 0 };
    if (stats) state.stats = stats;
    totals.inputTokens += delta.inputTokens;
    totals.outputTokens += delta.outputTokens;
    totals.cost += delta.cost;
    totals.turnCount += 1;
    state.turns += 1;

    await deps.store.finishTurn(turnId, {
      status: failure ? "error" : preempted && !stop ? "preempted" : "completed",
      thinking: transcript.thinking,
      toolCalls: transcript.toolCalls ? JSON.stringify(transcript.toolCalls) : null,
      finalText: transcript.text || null,
      postedSeqs: state.posted.seqs,
      ...delta,
      error: failure,
    });

    await deps.publish("turn_ended", {
      turnId,
      memberId: state.plan.id,
      memberName: state.plan.name,
      posted: state.posted.seqs,
      error: failure,
      ...delta,
      // The run's cumulative totals, not just this turn's delta: a client that
      // replays events it already accounted for (a reconnect, a room opened
      // mid-run) then converges on the same numbers instead of double counting.
      totals: { ...totals },
    });

    await deps.store.progress({ ...totals }).catch((err) => {
      console.error(`[council:${plan.runId}] Could not record progress:`, err);
    });

    if (failure && !stop) {
      await postSystem(`@${state.plan.name} could not finish its turn: ${failure}`);
    }

    return { posted: state.posted.seqs.length };
  }

  /** Start a turn and track it while it runs. */
  function launch(state: MemberState, round: number | undefined): Promise<TurnOutcome> {
    state.busy = true;
    const turn = runTurn(state, round).finally(() => {
      state.busy = false;
      inFlight.delete(turn);
    });
    inFlight.add(turn);
    return turn;
  }

  // ─── Stopping ─────────────────────────────────────────────────────────────

  /**
   * Whether the run must end now.
   *
   * Checked before every turn and between the turns of a round, so a budget or a
   * stop vote costs at most the turn that was already running.
   */
  async function shouldStop(): Promise<boolean> {
    if (stop) return true;
    // A Redis hiccup must not end the run — the same tolerance the in-flight
    // turn's abort poll has. The flag is re-checked between turns either way.
    const aborted = await deps.isAbortRequested().catch((err) => {
      console.error(`[council:${plan.runId}] Could not check for a stop request:`, err);
      return false;
    });
    if (aborted) {
      requestStop("aborted", true);
      return true;
    }
    if (deadline !== null && deps.now() >= deadline) {
      requestStop("budget:time", true);
      return true;
    }
    const { maxTokens, maxCostUsd } = plan.budget;
    if (maxTokens !== null && totals.inputTokens + totals.outputTokens >= maxTokens) {
      requestStop("budget:tokens", true);
      return true;
    }
    if (maxCostUsd !== null && totals.cost >= maxCostUsd) {
      requestStop("budget:cost", true);
      return true;
    }
    if (awaitingUser) {
      // The members that were mid-turn finish (their posts may address the owner
      // too); the room then waits for a reply.
      stop = { reason: "user-question" };
      return true;
    }
    return false;
  }

  /** Wait for the turns still in flight, which the loop no longer watches. */
  async function settleRunning(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  // ─── The schedulers ───────────────────────────────────────────────────────

  async function runParallel(): Promise<void> {
    while (!(await shouldStop())) {
      // Before deciding there is nothing to do: the owner may have spoken since
      // the last batch, and their message is what the next batch is for.
      await absorbExternalMessages();

      const ready = [...states.values()].filter((state) => state.inbox.length > 0 && !state.busy);

      if (ready.length === 0) {
        if (inFlight.size === 0) {
          stop = { reason: "no-pending-work" };
          return;
        }
        await settleRunning();
        continue;
      }

      await Promise.all(ready.map((state) => launch(state, undefined)));
    }
  }

  async function runRounds(): Promise<void> {
    let round = 0;
    while (!(await shouldStop())) {
      // Everyone speaks each round, so a message from the owner needs no wake —
      // the members see it in their next turn. The cursor is advanced anyway, so
      // it is never re-read as if it were new.
      await absorbExternalMessages();

      round += 1;
      let posted = 0;

      for (const state of states.values()) {
        if (await shouldStop()) break;
        const outcome = await launch(state, round);
        posted += outcome.posted;
      }

      if (stop) return;
      if (posted === 0) {
        // A whole round in which nobody spoke: the room has gone quiet, and
        // paying for another round would only produce the same silence.
        stop = { reason: "no-pending-work" };
        return;
      }
    }
  }

  // ─── Go ───────────────────────────────────────────────────────────────────

  // Liveness, independent of turns: the watchdog treats a run that stopped
  // reporting as one whose process went away.
  const heartbeat = setInterval(() => {
    void deps.store.progress({ ...totals }).catch((err) => {
      console.error(`[council:${plan.runId}] Heartbeat failed:`, err);
    });
  }, HEARTBEAT_MS);

  try {
    if (participants.length === 0) {
      stop = { reason: "no-members" };
      await postSystem("No enabled members, so this run has nothing to do.");
    } else {
      // The opening: the owner's message wakes the members it addressed, or all
      // of them when it addressed nobody. Round-robin ignores inboxes — every
      // member takes a turn — but the wakes are still recorded on the first turn.
      const opening = plan.openingMemberIds;
      const woken =
        opening === null ? participants : participants.filter((m) => opening.includes(m.id));
      for (const member of woken) wake(member.id, OPENING_SEQ);

      if (plan.orchestration === "round-robin") await runRounds();
      else await runParallel();
    }
  } catch (err) {
    console.error(`[council:${plan.runId}] Run loop failed:`, err);
    requestStop("error", true, errorMessage(err));
  } finally {
    clearInterval(heartbeat);
    await settleRunning();
    for (const state of states.values()) {
      try {
        state.session?.session.dispose();
      } catch (err) {
        console.error(`[council:${plan.runId}] Failed to dispose ${state.plan.name}:`, err);
      }
    }
  }

  const reason = stop?.reason ?? "no-pending-work";
  return {
    stopReason: reason,
    error: stop?.error ?? null,
    awaitingUser: reason === "user-question",
    ...totals,
  };
}

/**
 * Run a turn until it finishes, or until something stops it.
 *
 * A budget and a stop request both have to reach a turn that is *already*
 * running: without that, a budget could only be noticed between turns (so one
 * long turn could run the clock out by any amount) and a Stop press would wait
 * for the model to finish on its own.
 */
async function raceWithStops(
  work: Promise<unknown>,
  stops: Array<StopWatch | null>,
): Promise<void> {
  const active = stops.filter((stop): stop is StopWatch => stop !== null);
  // A watch that loses the race rejects with nothing listening.
  for (const stop of active) void stop.promise.catch(() => {});

  try {
    await Promise.race([work, ...active.map((stop) => stop.promise)]);
  } finally {
    for (const stop of active) stop.cancel();
  }
}

interface StopWatch {
  promise: Promise<never>;
  cancel: () => void;
}

/**
 * Reject when the turn's time budget is reached.
 *
 * The callback requests the abort but is not awaited: the budget has already
 * been spent, and a session that will not settle must not keep the run alive.
 */
function deadlineWatch(timeoutMs: number | null, onExpire: () => void): StopWatch | null {
  if (timeoutMs === null) return null;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        onExpire();
        reject(new Error("Turn stopped: the run's time budget was reached."));
      },
      Math.max(0, timeoutMs),
    );
  });

  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Reject as soon as the run is asked to stop, ending the turn in flight.
 *
 * Polled rather than pushed: the request arrives on another request's stack
 * (another tab, another replica, the watchdog), and Redis is what carries it.
 * The stop itself never waits on `abort()` — see `abortAll`.
 */
function abortWatch(deps: CouncilRunDeps, onAbort: () => void): StopWatch {
  const pollMs = deps.abortPollMs ?? ABORT_POLL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const promise = new Promise<never>((_resolve, reject) => {
    const poll = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void deps
          .isAbortRequested()
          .then((aborted) => {
            if (cancelled) return;
            if (!aborted) {
              poll();
              return;
            }
            onAbort();
            reject(new Error("Turn stopped: the run was aborted."));
          })
          .catch((err) => {
            // A Redis hiccup must not end the turn; the loop's own check retries.
            console.error("Failed to check whether the council run was aborted:", err);
            poll();
          });
      }, pollMs);
    };
    poll();
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Reject when a turn has gone completely silent.
 *
 * Budgets watch the *run*; this watches the *turn*. The loop heartbeats while a
 * turn is in flight, so a model whose server went away — or a tool that never
 * returns — leaves a run that looks perfectly alive and will not end on its own
 * until its wall-clock budget (which may be unlimited). Silence is the
 * evidence: every session event resets the window, so a turn that is still
 * streaming, still thinking or still running tools is never touched.
 */
function idleWatch(
  session: AgentSession,
  timeoutMs: number,
  label: string,
  onStall: () => void,
): StopWatch {
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<never>((_resolve, rejectFn) => {
    reject = rejectFn;
  });

  const idle = createAgentIdleTimeout({
    session,
    timeoutMs,
    label,
    onTimeout: () => {
      onStall();
      reject(new Error(`Turn stalled: no activity for ${Math.round(timeoutMs / 1000)}s.`));
    },
  });

  return { promise, cancel: () => idle.clear() };
}

interface TurnTranscript {
  text: string;
  thinking: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string | undefined;
    isError: boolean | undefined;
  }>;
}

/**
 * Observe one turn of a member's session.
 *
 * The session's *final* assistant content is what carries the turn's thinking
 * and its tool calls, and `agent_end` is where Pi hands that over; the live
 * publishes are for the owner watching the room. `agent_settled` (not
 * `agent_end`) is the end of the turn — a run may continue after compaction —
 * but `prompt()` resolves on it, so this only has to stop listening.
 */
function collectTurn(
  session: AgentSession,
  state: MemberState,
  deps: CouncilRunDeps,
  onToolEnd?: () => void,
): { stop: () => void; snapshot: () => TurnTranscript } {
  let content: unknown[] = [];
  let thinking: string | null = null;
  let text = "";
  let toolCalls: TurnTranscript["toolCalls"] = [];
  const results = new Map<
    string,
    { name: string; args: Record<string, unknown>; result?: string; isError?: boolean }
  >();
  let lastThinkingPublish = 0;

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        if (event.message.role !== "assistant") return;
        content = (event.message as { content: unknown[] }).content;
        const live = extractThinking(content);
        if (live) {
          thinking = live;
          // Throttled: a full reasoning trace arrives a token at a time, and the
          // room only needs the newest state.
          const now = deps.now();
          if (now - lastThinkingPublish >= THINKING_PUBLISH_INTERVAL_MS) {
            lastThinkingPublish = now;
            void deps.publish("thinking", {
              memberId: state.plan.id,
              memberName: state.plan.name,
              thinking: live,
            });
          }
        }
        return;
      }

      case "tool_execution_start": {
        results.set(event.toolCallId, { name: event.toolName, args: event.args });
        void deps.publish("tool_call", {
          memberId: state.plan.id,
          memberName: state.plan.name,
          phase: "start",
          toolCallId: event.toolCallId,
          tool: event.toolName,
          args: event.args,
        });
        return;
      }

      case "tool_execution_end": {
        const existing = results.get(event.toolCallId);
        if (existing) {
          existing.result = normalizeToolResult(event.result);
          existing.isError = event.isError;
        }
        void deps.publish("tool_call", {
          memberId: state.plan.id,
          memberName: state.plan.name,
          phase: "end",
          toolCallId: event.toolCallId,
          tool: event.toolName,
          isError: event.isError,
        });
        onToolEnd?.();
        return;
      }

      case "agent_end": {
        if (event.willRetry) return;
        const last = [...event.messages]
          .reverse()
          .find((message) => message.role === "assistant") as { content: unknown[] } | undefined;
        if (!last) return;
        const built = buildFinalAssistantMessage(last.content, results);
        content = last.content;
        text = built.text;
        thinking = built.thinking ?? thinking;
        toolCalls = built.toolCalls;
        return;
      }

      default:
        return;
    }
  });

  return {
    stop: () => {
      unsubscribe();
      if (thinking) {
        void deps.publish("thinking", {
          memberId: state.plan.id,
          memberName: state.plan.name,
          thinking,
        });
      }
    },
    snapshot: () => ({
      text,
      thinking: thinking ?? extractThinking(content),
      toolCalls,
    }),
  };
}

/** A tool result as text, for the turn record. */
function normalizeToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    const blocks = (result as { content?: unknown }).content;
    if (Array.isArray(blocks)) {
      return blocks
        .filter(
          (block): block is { type: string; text?: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: string }).type === "text",
        )
        .map((block) => block.text ?? "")
        .join("");
    }
    return JSON.stringify(result);
  }
  return String(result ?? "");
}

/** A session's cumulative usage, or null when it cannot be read. */
function readStats(
  session: AgentSession,
  _runId: string,
): { inputTokens: number; outputTokens: number; cost: number } | null {
  try {
    const stats = session.getSessionStats();
    return {
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cost: stats.cost,
    };
  } catch (err) {
    console.error(`[council:${_runId}] Failed to read session stats:`, err);
    return null;
  }
}
