"use client";

/**
 * The room's live channel.
 *
 * One `EventSource` on `/api/council/[councilId]/stream` per open room. The
 * stream is treated as a *signal*, never as the room itself: `message`,
 * `notice` and `run_ended` mean "the room moved, refetch it from the REST
 * route", so a reconnecting tab cannot end up with a room that only exists in
 * its own event replay. What the stream owns is the state REST does not carry
 * while a run is in flight. each member's cumulative thinking, its live tool
 * calls and whether it is busy. plus the running budget totals.
 *
 * The connection self-heals: the browser's `EventSource` reconnects on a
 * transport error and sends `Last-Event-ID`, and the server replays its buffer,
 * so a dropped connection loses nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunBudget } from "@/lib/council/config";

/** A tool call as it streams in. partial until its `end` event. */
export interface CouncilLiveToolCall {
  toolCallId: string;
  tool: string;
  args: Record<string, unknown> | null;
  done: boolean;
  isError: boolean;
}

/** One member's live state while the room is working. */
export interface CouncilMemberLive {
  memberId: string;
  memberName: string;
  busy: boolean;
  /** Cumulative reasoning for the member's current turn. */
  thinking: string | null;
  toolCalls: CouncilLiveToolCall[];
  /** Room seqs that woke the current turn. */
  triggeredBy: number[];
  round: number | null;
  turnId: string | null;
}

/**
 * The run's cumulative totals, as each turn's event reports them (and as the
 * active run's record seeds them). Cumulative, not a running sum of deltas: a
 * replay can then never count a turn twice.
 */
export interface CouncilRunTotals {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  turnCount: number;
}

/** The run the stream announced, with the ceilings it started under. */
export interface CouncilStreamRun {
  runId: string;
  orchestration: string;
  memberNames: string[];
  budget: RunBudget;
}

export interface CouncilStreamEnded {
  runId: string;
  stopReason: string | null;
  error: string | null;
  awaitingUser: boolean;
}

export interface CouncilStreamOptions {
  councilId: string;
  /** A room message or notice landed. refetch the room from REST. */
  onRoomChanged?: () => void;
  onRunStarted?: (run: CouncilStreamRun) => void;
  onRunEnded?: (ended: CouncilStreamEnded) => void;
}

export interface CouncilStreamState {
  /** True once the server has said `ready` (or sent a heartbeat). */
  connected: boolean;
  members: Record<string, CouncilMemberLive>;
  /** The run the stream announced; null when the room is quiet. */
  liveRun: CouncilStreamRun | null;
  totals: CouncilRunTotals;
  /**
   * Seed the running totals from an active run loaded over REST, so a page
   * opened mid-run does not start its meters at zero. Ignored once the stream
   * has already seen the same run.
   */
  seedRun: (runId: string, totals: CouncilRunTotals) => void;
}

const ZERO_TOTALS: CouncilRunTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  turnCount: 0,
};

/**
 * The newest of two readings of the same run's cumulative totals.
 *
 * Every counter only rises within a run, so the higher value is always the more
 * recent one. Taking the maximum rather than replacing is what makes repeated or
 * out-of-order delivery harmless: an event replayed from the buffer (a room
 * opened mid-run) cannot push the meters backwards past the REST seed, and the
 * seed cannot be undone by a replayed event either.
 */
function mergeTotals(prev: CouncilRunTotals, next: CouncilRunTotals): CouncilRunTotals {
  return {
    inputTokens: Math.max(prev.inputTokens, next.inputTokens),
    outputTokens: Math.max(prev.outputTokens, next.outputTokens),
    cost: Math.max(prev.cost, next.cost),
    turnCount: Math.max(prev.turnCount, next.turnCount),
  };
}

function parseEvent<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch (err) {
    console.error("Failed to parse a council stream event:", err);
    return null;
  }
}

function emptyMember(memberId: string, memberName: string): CouncilMemberLive {
  return {
    memberId,
    memberName,
    busy: false,
    thinking: null,
    toolCalls: [],
    triggeredBy: [],
    round: null,
    turnId: null,
  };
}

export function useCouncilStream(options: CouncilStreamOptions): CouncilStreamState {
  const { councilId } = options;

  const [connected, setConnected] = useState(false);
  const [members, setMembers] = useState<Record<string, CouncilMemberLive>>({});
  const [liveRun, setLiveRun] = useState<CouncilStreamRun | null>(null);
  const [totals, setTotals] = useState<CouncilRunTotals>(ZERO_TOTALS);

  // The run the totals belong to, so a page that seeds from REST does not
  // re-seed (and double count) on every later refetch.
  const runIdRef = useRef<string | null>(null);

  // Callbacks live in a ref so the stream effect stays keyed on the council id
  // alone. inline handlers would otherwise tear the connection down each render.
  const callbacksRef = useRef(options);
  useEffect(() => {
    callbacksRef.current = options;
  });

  const seedRun = useCallback((runId: string, seed: CouncilRunTotals) => {
    if (runIdRef.current === runId) return;
    runIdRef.current = runId;
    setTotals(seed);
  }, []);

  useEffect(() => {
    if (!councilId) return;

    const source = new EventSource(`/api/council/${councilId}/stream`);

    source.addEventListener("ready", () => {
      setConnected(true);
    });
    // Heartbeats keep the connection observable; they carry no state.
    source.addEventListener("ping", () => {
      setConnected(true);
    });

    source.addEventListener("message", () => {
      callbacksRef.current.onRoomChanged?.();
    });
    source.addEventListener("notice", () => {
      callbacksRef.current.onRoomChanged?.();
    });

    source.addEventListener("run_started", (event) => {
      const payload = parseEvent<{
        runId: string;
        orchestration: string;
        members: string[];
        budget: RunBudget;
      }>((event as MessageEvent).data);
      if (!payload) return;
      // A new run's meters start where that run's record says, not where the
      // previous run left them.
      setTotals(ZERO_TOTALS);
      setMembers({});
      const run: CouncilStreamRun = {
        runId: payload.runId,
        orchestration: payload.orchestration,
        memberNames: payload.members ?? [],
        budget: payload.budget,
      };
      setLiveRun(run);
      callbacksRef.current.onRunStarted?.(run);
    });

    source.addEventListener("run_ended", (event) => {
      const payload = parseEvent<{
        runId: string;
        stopReason?: string | null;
        error?: string | null;
        awaitingUser?: boolean;
      }>((event as MessageEvent).data);
      setLiveRun(null);
      setMembers({});
      if (!payload) return;
      callbacksRef.current.onRunEnded?.({
        runId: payload.runId,
        stopReason: payload.stopReason ?? null,
        error: payload.error ?? null,
        awaitingUser: payload.awaitingUser ?? false,
      });
    });

    source.addEventListener("turn_started", (event) => {
      const payload = parseEvent<{
        turnId: string;
        memberId: string;
        memberName: string;
        triggeredBy: number[];
        round: number | null;
      }>((event as MessageEvent).data);
      if (!payload) return;
      setMembers((prev) => ({
        ...prev,
        [payload.memberId]: {
          ...(prev[payload.memberId] ?? emptyMember(payload.memberId, payload.memberName)),
          memberName: payload.memberName,
          busy: true,
          thinking: null,
          toolCalls: [],
          triggeredBy: payload.triggeredBy ?? [],
          round: payload.round ?? null,
          turnId: payload.turnId,
        },
      }));
    });

    source.addEventListener("thinking", (event) => {
      const payload = parseEvent<{ memberId: string; memberName: string; thinking: string }>(
        (event as MessageEvent).data,
      );
      if (!payload) return;
      setMembers((prev) => ({
        ...prev,
        [payload.memberId]: {
          ...(prev[payload.memberId] ?? emptyMember(payload.memberId, payload.memberName)),
          memberName: payload.memberName,
          // Cumulative per turn, so the newest payload replaces, never appends.
          thinking: payload.thinking,
        },
      }));
    });

    source.addEventListener("tool_call", (event) => {
      const payload = parseEvent<{
        memberId: string;
        memberName: string;
        phase: "start" | "end";
        toolCallId: string;
        tool: string;
        args?: Record<string, unknown>;
        isError?: boolean;
      }>((event as MessageEvent).data);
      if (!payload) return;

      setMembers((prev) => {
        const existing =
          prev[payload.memberId] ?? emptyMember(payload.memberId, payload.memberName);
        const base: CouncilMemberLive = { ...existing, memberName: payload.memberName };

        if (payload.phase === "start") {
          const call: CouncilLiveToolCall = {
            toolCallId: payload.toolCallId,
            tool: payload.tool,
            args: payload.args ?? null,
            done: false,
            isError: false,
          };
          return { ...prev, [payload.memberId]: { ...base, toolCalls: [...base.toolCalls, call] } };
        }

        const toolCalls = base.toolCalls.map((call) =>
          call.toolCallId === payload.toolCallId
            ? { ...call, done: true, isError: payload.isError ?? false }
            : call,
        );
        return { ...prev, [payload.memberId]: { ...base, toolCalls } };
      });
    });

    source.addEventListener("turn_ended", (event) => {
      const payload = parseEvent<{
        turnId: string;
        memberId: string;
        inputTokens?: number;
        outputTokens?: number;
        cost?: number;
        /** The run's cumulative totals after this turn. */
        totals?: CouncilRunTotals;
      }>((event as MessageEvent).data);
      if (!payload) return;
      setMembers((prev) => {
        const existing = prev[payload.memberId];
        if (!existing) return prev;
        return {
          ...prev,
          [payload.memberId]: {
            ...existing,
            busy: false,
            thinking: null,
            toolCalls: [],
            triggeredBy: [],
            turnId: null,
          },
        };
      });
      if (!payload.totals) return;
      setTotals((prev) => mergeTotals(prev, payload.totals!));
    });

    return () => {
      source.close();
      setConnected(false);
    };
  }, [councilId]);

  return { connected, members, liveRun, totals, seedRun };
}
