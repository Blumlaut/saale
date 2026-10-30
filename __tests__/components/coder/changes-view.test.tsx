// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The Project tab's file list.
 *
 * A screenshot is the one change a diff cannot spell out, and a row that opened
 * "No changes in this file" over a changed image said the opposite of what the
 * user was looking at.
 */

const http = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("@/lib/http", () => ({ fetchJson: http.fetchJson }));

import { ChangesView } from "@/components/coder/changes-view";
import type { CoderChange, CoderSessionState } from "@/components/coder/use-coder-data";

const STATE: CoderSessionState = {
  worktree: { path: "worktrees/saale/c-1", branch: "wt/c-1", baseSha: "sha", mode: "worktree" },
  project: { id: "project-1", name: "Saale", slug: "saale" },
  branch: "wt/c-1",
  head: "sha",
  upstream: "",
  ahead: 0,
  behind: 0,
  changes: [],
  commits: [],
  commitsTruncated: false,
  remotes: [],
  stashes: 0,
  scripts: [],
  provisioning: null,
  setupFailure: null,
};

function change(path: string): CoderChange {
  return {
    path,
    originalPath: null,
    added: null,
    deleted: null,
    staged: false,
    unstaged: false,
    untracked: true,
    conflicted: false,
  };
}

function renderChanges(changes: CoderChange[]) {
  return render(
    <ChangesView
      sessionId="s-1"
      state={{ ...STATE, changes }}
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
  http.fetchJson.mockReset();
  http.fetchJson.mockResolvedValue({ diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n" });
});

describe("ChangesView: a file's diff", () => {
  it("shows an image instead of asking git for lines", async () => {
    renderChanges([change(".tmp/shots/probe.png")]);

    fireEvent.click(screen.getByTitle(".tmp/shots/probe.png"));

    const image = await screen.findByRole("img", { name: "probe.png" });
    expect(image).toHaveAttribute(
      "src",
      "/api/coder/sessions/s-1/blob?path=.tmp%2Fshots%2Fprobe.png",
    );
    expect(http.fetchJson).not.toHaveBeenCalled();
  });

  it("says a binary file has no text to show", async () => {
    renderChanges([change("exports/report.zip")]);

    fireEvent.click(screen.getByTitle("exports/report.zip"));

    expect(await screen.findByText("A binary file has no text to show.")).toBeTruthy();
    expect(http.fetchJson).not.toHaveBeenCalled();
  });

  it("reads a diff for a text file", async () => {
    renderChanges([change("src/app.ts")]);

    fireEvent.click(screen.getByTitle("src/app.ts"));

    expect(await screen.findByText("+new")).toBeTruthy();
    await waitFor(() =>
      expect(http.fetchJson).toHaveBeenCalledWith(
        expect.stringContaining("/api/coder/sessions/s-1/diff?path=src%2Fapp.ts"),
      ),
    );
  });
});
