// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import {
  PullRequestBadge,
  pullRequestStateLabel,
  pullRequestStateTone,
} from "@/components/coder/pull-request-badge";

/**
 * The pull request badge.
 *
 * A list row can only say where the request stands, so its colour has to mean
 * the state: grey while it is a draft, green while it is open, purple once it
 * has merged, red once it is closed.
 */

const BASE = {
  number: 128,
  title: "Add the git actions",
  url: "https://github.com/acme/saale/pull/128",
};

describe("pullRequestStateTone", () => {
  it("gives a draft the muted colour, whatever the state says", () => {
    expect(pullRequestStateTone({ state: "OPEN", draft: true })).toBe("text-muted-foreground");
  });

  it("reads open as green, merged as purple and closed as red", () => {
    expect(pullRequestStateTone({ state: "OPEN", draft: false })).toContain("emerald");
    expect(pullRequestStateTone({ state: "MERGED", draft: false })).toContain("purple");
    expect(pullRequestStateTone({ state: "CLOSED", draft: false })).toBe("text-destructive");
  });

  it("does not care what case the forge answered in", () => {
    expect(pullRequestStateTone({ state: "merged", draft: false })).toContain("purple");
  });
});

describe("pullRequestStateLabel", () => {
  it("says draft for a draft, and the state in words otherwise", () => {
    expect(pullRequestStateLabel({ state: "OPEN", draft: true })).toBe("draft");
    expect(pullRequestStateLabel({ state: "MERGED", draft: false })).toBe("merged");
  });
});

describe("PullRequestBadge", () => {
  it("links to the request and says where it stands", () => {
    render(
      <PullRequestBadge
        pullRequest={{ ...BASE, state: "OPEN", draft: false }}
        tone="state"
        showState
      />,
    );

    const badge = screen.getByRole("link", { name: /128.*open/i });
    expect(badge).toHaveAttribute("href", BASE.url);
    expect(badge).toHaveAttribute("title", "Add the git actions · open");
  });

  it("colours the checks instead of the state when the panel asks it to", () => {
    render(
      <PullRequestBadge
        pullRequest={{
          ...BASE,
          state: "OPEN",
          draft: false,
          checks: { passed: 1, failed: 1, pending: 0 },
        }}
      />,
    );

    expect(screen.getByRole("link", { name: /#128/ }).className).toContain("red");
  });

  it("is text, not a link, when the forge gave it no URL", () => {
    render(<PullRequestBadge pullRequest={{ ...BASE, url: "", state: "DRAFT", draft: true }} />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("#128")).toBeInTheDocument();
  });
});
