// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The git the panel offers: staging, the commit box, and where the branch
 * stands against its remote.
 *
 * These are the controls that write, so the test is about what reaches the
 * server, not about the markup: a commit that skips the stage step commits
 * nothing, and a "local" commit that is not marked is the whole complaint.
 */

const http = vi.hoisted(() => ({ fetchJson: vi.fn(), postJson: vi.fn() }));
vi.mock("@/lib/http", () => ({ fetchJson: http.fetchJson, postJson: http.postJson }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ChangesView } from "@/components/coder/changes-view";
import type { CoderChange, CoderSessionState } from "@/components/coder/use-coder-data";

const STATE: CoderSessionState = {
  worktree: { path: "worktrees/saale/c-1", branch: "wt/c-1", baseSha: "sha", mode: "worktree" },
  project: { id: "project-1", name: "Saale", slug: "saale" },
  branch: "wt/c-1",
  head: "sha",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  changes: [],
  commits: [],
  commitsTruncated: false,
  remotes: [{ name: "origin", url: "git@github.com:acme/saale.git" }],
  stashes: 0,
  scripts: [],
  provisioning: null,
  setupFailure: null,
};

function change(path: string, overrides: Partial<CoderChange> = {}): CoderChange {
  return {
    path,
    originalPath: null,
    added: 1,
    deleted: 0,
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
    ...overrides,
  };
}

function renderView(state: Partial<CoderSessionState> = {}) {
  return render(
    <ChangesView
      sessionId="s-1"
      state={{ ...STATE, ...state }}
      onRefresh={() => {}}
      refreshing={false}
      activeCommitSha={null}
      onOpenCommitFile={() => {}}
      pullRequest={null}
      onLoadMoreCommits={() => {}}
      loadingMoreCommits={false}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  http.fetchJson.mockResolvedValue({ diff: "" });
  http.postJson.mockResolvedValue({ ok: true });
});

describe("ChangesView: what is staged", () => {
  it("lists staged and unstaged paths apart, each with its own bulk action", () => {
    renderView({
      changes: [change("src/staged.ts", { staged: true, unstaged: false }), change("src/loose.ts")],
    });

    expect(screen.getByText("staged.ts")).toBeTruthy();
    expect(screen.getByText("loose.ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unstage all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stage all" })).toBeTruthy();
  });

  it("stages one path from its row", () => {
    renderView({ changes: [change("src/loose.ts")] });

    fireEvent.click(screen.getByRole("button", { name: "Stage loose.ts" }));

    expect(http.postJson).toHaveBeenCalledWith("/api/coder/sessions/s-1/git", {
      action: "stage",
      paths: ["src/loose.ts"],
    });
  });

  it("says a conflicted file needs a decision instead of offering a diff alone", () => {
    renderView({ changes: [change("src/merged.ts", { conflicted: true })] });

    fireEvent.click(screen.getByTitle("src/merged.ts"));

    expect(screen.getByText(/git could not merge this file/)).toBeTruthy();
  });
});

describe("ChangesView: reading a diff", () => {
  it("reads no diff until a file is unfolded, then only that file's", async () => {
    renderView({ changes: [change("src/loose.ts"), change("src/other.ts")] });
    expect(http.fetchJson).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("src/loose.ts"));

    await waitFor(() => expect(http.fetchJson).toHaveBeenCalledTimes(1));
    expect(http.fetchJson).toHaveBeenCalledWith("/api/coder/sessions/s-1/diff?path=src%2Floose.ts");
  });
});

describe("ChangesView: committing", () => {
  it("keeps the message box behind a button, and hides the button on a clean tree", () => {
    const { unmount } = renderView({ changes: [] });
    expect(screen.queryByRole("button", { name: /Commit…/ })).toBeNull();
    expect(screen.queryByLabelText("Commit message")).toBeNull();
    unmount();

    renderView({ changes: [change("src/loose.ts")] });
    expect(screen.getByRole("button", { name: /Commit…/ })).toBeTruthy();
    // A box nobody asked for is not on the panel until it is opened.
    expect(screen.queryByLabelText("Commit message")).toBeNull();
  });

  it("stages everything first when nothing is staged, then commits", async () => {
    renderView({ changes: [change("src/loose.ts")] });

    fireEvent.click(screen.getByRole("button", { name: /Commit…/ }));
    expect(screen.getByText(/Everything in the worktree is staged first/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Commit message"), {
      target: { value: "fix the panel" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Commit$/ }));

    await waitFor(() => expect(http.postJson).toHaveBeenCalledTimes(2));
    expect(http.postJson).toHaveBeenNthCalledWith(1, "/api/coder/sessions/s-1/git", {
      action: "stage",
      paths: undefined,
    });
    expect(http.postJson).toHaveBeenNthCalledWith(2, "/api/coder/sessions/s-1/git", {
      action: "commit",
      message: "fix the panel",
      amend: false,
      push: false,
    });
  });

  it("keeps Commit disabled until there is a message", () => {
    renderView({ changes: [change("src/loose.ts", { staged: true, unstaged: false })] });

    fireEvent.click(screen.getByRole("button", { name: /Commit…/ }));

    expect(screen.getByRole("button", { name: /^Commit$/ })).toBeDisabled();
  });
});

describe("ChangesView: the history", () => {
  const commit = {
    sha: "abcdef1234567890",
    shortSha: "abcdef1",
    subject: "a commit only this checkout has",
    date: new Date().toISOString(),
    author: "Ada",
    refs: [],
    pushed: false,
  };

  it("marks a commit the upstream does not have, and names the line it crossed", () => {
    renderView({ commits: [commit], ahead: 1 });

    expect(screen.getByLabelText("Not pushed")).toBeTruthy();
    expect(screen.getByText("1 local")).toBeTruthy();
  });

  it("offers older history when the branch has more of it", () => {
    const onLoadMore = vi.fn();
    render(
      <ChangesView
        sessionId="s-1"
        state={{ ...STATE, commits: [commit], commitsTruncated: true }}
        onRefresh={() => {}}
        refreshing={false}
        activeCommitSha={null}
        onOpenCommitFile={() => {}}
        pullRequest={null}
        onLoadMoreCommits={onLoadMore}
        loadingMoreCommits={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Load older commits/ }));

    expect(onLoadMore).toHaveBeenCalled();
  });
});

describe("ChangesView: the remote", () => {
  it("fetches from the branch row", () => {
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "Fetch from the remote" }));

    expect(http.postJson).toHaveBeenCalledWith("/api/coder/sessions/s-1/git", {
      action: "fetch",
    });
  });

  it("cannot pull a branch that has no upstream", () => {
    renderView({ upstream: "", behind: 2 });

    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
  });

  it("cannot talk to a remote a project does not have", () => {
    renderView({ remotes: [] });

    expect(screen.getByRole("button", { name: "Fetch from the remote" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
  });
});
