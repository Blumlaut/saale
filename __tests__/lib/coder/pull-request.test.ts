import { describe, expect, it } from "vitest";
import { parsePullRequest } from "@/lib/coder/pull-request";

/**
 * What `gh pr view --json` answers.
 *
 * The badge on the branch is the only thing that says a pull request exists, so
 * a shape gh changes, or a check kind it adds, must not take the badge down.
 */

const OPEN_PR = {
  number: 42,
  title: "Add the git actions",
  state: "OPEN",
  url: "https://github.com/acme/saale/pull/42",
  isDraft: false,
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { __typename: "CheckRun", conclusion: "SUCCESS", status: "COMPLETED" },
    { __typename: "CheckRun", conclusion: "FAILURE", status: "COMPLETED" },
    { __typename: "CheckRun", conclusion: null, status: "IN_PROGRESS" },
    { __typename: "StatusContext", state: "SUCCESS" },
  ],
};

describe("parsePullRequest", () => {
  it("reads the badge's numbers, its state and its checks", () => {
    const parsed = parsePullRequest(JSON.stringify(OPEN_PR));

    expect(parsed).toMatchObject({
      number: 42,
      state: "OPEN",
      draft: false,
      reviewDecision: "APPROVED",
      url: "https://github.com/acme/saale/pull/42",
    });
    expect(parsed?.checks).toEqual({ passed: 2, failed: 1, pending: 1 });
  });

  it("has no check counts when the pull request ran none", () => {
    const parsed = parsePullRequest(JSON.stringify({ ...OPEN_PR, statusCheckRollup: [] }));
    expect(parsed?.checks).toBeNull();
  });

  it("reads a draft", () => {
    expect(parsePullRequest(JSON.stringify({ ...OPEN_PR, isDraft: true }))?.draft).toBe(true);
  });

  it("is null when gh printed something that is not a pull request", () => {
    expect(parsePullRequest("")).toBeNull();
    expect(parsePullRequest("no pull requests found for branch")).toBeNull();
    expect(parsePullRequest(JSON.stringify({ state: "OPEN" }))).toBeNull();
  });
});
