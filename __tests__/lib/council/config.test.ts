import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_BUDGET,
  isCouncilOrchestration,
  isStopVoteThreshold,
  normalizeOrchestration,
  normalizeStopVoteThreshold,
  resolveRunBudget,
  stopVoteQuorum,
} from "@/lib/council/config";

describe("stopVoteQuorum", () => {
  it("needs more than half the members for a majority", () => {
    expect(stopVoteQuorum("majority", 2)).toBe(2);
    expect(stopVoteQuorum("majority", 3)).toBe(2);
    expect(stopVoteQuorum("majority", 4)).toBe(3);
    expect(stopVoteQuorum("majority", 8)).toBe(5);
  });

  it("needs every member for a unanimous vote", () => {
    expect(stopVoteQuorum("unanimous", 5)).toBe(5);
  });

  it("needs one member for an any-one vote", () => {
    expect(stopVoteQuorum("any", 8)).toBe(1);
  });

  it("resolves an empty council to a quorum it can actually reach", () => {
    // A quorum of 1 for a council with no members would be a vote nobody can cast.
    expect(stopVoteQuorum("majority", 0)).toBe(0);
    expect(stopVoteQuorum("unanimous", 0)).toBe(0);
    expect(stopVoteQuorum("any", 0)).toBe(0);
  });
});

describe("stored shape", () => {
  it("accepts the known values and refuses the rest", () => {
    expect(isCouncilOrchestration("parallel")).toBe(true);
    expect(isCouncilOrchestration("round-robin")).toBe(true);
    expect(isCouncilOrchestration("sequential")).toBe(false);
    expect(isStopVoteThreshold("majority")).toBe(true);
    expect(isStopVoteThreshold("unanimous")).toBe(true);
    expect(isStopVoteThreshold("any")).toBe(true);
    expect(isStopVoteThreshold("half")).toBe(false);
  });

  it("falls back rather than trusting a stored value", () => {
    expect(normalizeOrchestration(null)).toBe("parallel");
    expect(normalizeOrchestration("nonsense")).toBe("parallel");
    expect(normalizeOrchestration("round-robin")).toBe("round-robin");
    expect(normalizeStopVoteThreshold(undefined)).toBe("majority");
    expect(normalizeStopVoteThreshold("any")).toBe("any");
  });
});

describe("resolveRunBudget", () => {
  it("uses the defaults when nobody set anything", () => {
    expect(resolveRunBudget(null, null)).toEqual(DEFAULT_RUN_BUDGET);
  });

  it("lets a council override the default and a run override the council", () => {
    const budget = resolveRunBudget(
      { maxCostUsd: 2 },
      { maxCostUsd: 1, maxTokens: 500, maxDurationSeconds: 60 },
    );
    expect(budget).toEqual({ maxDurationSeconds: 60, maxTokens: 500, maxCostUsd: 2 });
  });

  it("reads zero as unlimited and an empty value as the default", () => {
    // A zero ceiling would stop a run the moment it started, so the value is
    // reserved for "unlimited"; an unset column inherits instead.
    const unlimited = resolveRunBudget(null, { maxTokens: 0, maxCostUsd: null });
    expect(unlimited.maxTokens).toBeNull();
    expect(unlimited.maxCostUsd).toBe(DEFAULT_RUN_BUDGET.maxCostUsd);
    expect(resolveRunBudget(null, { maxDurationSeconds: 0 }).maxDurationSeconds).toBeNull();
  });

  it("ignores nonsense and negative ceilings in favour of the fallback", () => {
    const budget = resolveRunBudget(
      { maxTokens: Number.NaN },
      { maxDurationSeconds: -5, maxCostUsd: Number.POSITIVE_INFINITY },
    );
    expect(budget.maxDurationSeconds).toBe(DEFAULT_RUN_BUDGET.maxDurationSeconds);
    expect(budget.maxTokens).toBe(DEFAULT_RUN_BUDGET.maxTokens);
    expect(budget.maxCostUsd).toBe(DEFAULT_RUN_BUDGET.maxCostUsd);
  });
});
