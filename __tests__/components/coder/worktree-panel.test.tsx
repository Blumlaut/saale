// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The right-hand worktree panel.
 *
 * It is the panel that says what a chat's checkout holds, so it is also the one
 * that has to say when the checkout is missing its install: a failed setup
 * script leaves a working tree that looks fine in every other view. The warning
 * sits above the tabs, because it is about the checkout and not about one view
 * of it.
 */

vi.mock("@/components/coder/use-ports", () => ({
  usePorts: () => ({ data: null, error: null, load: () => {}, stop: async () => {} }),
}));

// Monaco needs a real layout pass; the panel only has to reach it.
vi.mock("@/components/editor/monaco-diff-view", () => ({
  MonacoDiffView: () => <div data-testid="monaco-diff" />,
}));

const http = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("@/lib/http", () => ({ fetchJson: http.fetchJson }));

// The terminal opens a stream and the file browser lists a directory. Neither
// has anything to do with the warning, so both stand in as empty boxes.
vi.mock("@/components/coder/terminal-view", () => ({
  TerminalView: () => <div data-testid="terminal" />,
}));
vi.mock("@/components/files/file-browser", () => ({
  FileBrowser: () => <div data-testid="files" />,
}));

import { WorktreePanel } from "@/components/coder/worktree-panel";
import type { CoderSessionState } from "@/components/coder/use-coder-data";

const STATE: CoderSessionState = {
  worktree: { path: "worktrees/saale/c-1", branch: "wt/c-1", baseSha: "sha" },
  project: { id: "project-1", name: "Saale", slug: "saale" },
  branch: "wt/c-1",
  head: "sha",
  upstream: "",
  ahead: 0,
  behind: 0,
  changes: [],
  commits: [],
  scripts: [],
  provisioning: null,
  setupFailure: null,
};

function renderPanel(state: CoderSessionState | null) {
  return render(
    <WorktreePanel
      sessionId="s-1"
      state={state}
      loading={false}
      error={null}
      onRefresh={() => {}}
      refreshing={false}
    />,
  );
}

describe("WorktreePanel: a commit in the list", () => {
  beforeEach(() => {
    http.fetchJson.mockReset();
  });

  const commit = {
    sha: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
    shortSha: "a1b2c3d",
    subject: "read a tool's icon from the catalog once",
    date: new Date().toISOString(),
    author: "Ada",
  };

  function mockCommitDiff() {
    http.fetchJson.mockImplementation((url: string) => {
      if (url.includes("path=")) {
        return Promise.resolve({
          path: "src/app.ts",
          binary: false,
          original: "one\n",
          modified: "two\n",
        });
      }
      return Promise.resolve({
        files: [{ path: "src/app.ts", originalPath: null, status: "M", added: 1, deleted: 1 }],
      });
    });
  }

  it("unfolds its files in place, and opens a file's diff from there", async () => {
    mockCommitDiff();
    renderPanel({ ...STATE, commits: [commit] });

    // Folded, so the panel asks git for nothing.
    expect(http.fetchJson).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle(commit.sha));

    expect(await screen.findByText("app.ts")).toBeTruthy();
    expect(http.fetchJson).toHaveBeenCalledWith(expect.stringContaining(`sha=${commit.sha}`));

    fireEvent.click(screen.getByText("app.ts"));

    expect(await screen.findByTestId("monaco-diff")).toBeTruthy();
    await waitFor(() =>
      expect(http.fetchJson).toHaveBeenCalledWith(expect.stringContaining(`path=src%2Fapp.ts`)),
    );
  });

  it("keeps the unfolded commit when another tab is opened", async () => {
    mockCommitDiff();
    renderPanel({ ...STATE, commits: [commit] });

    fireEvent.click(screen.getByTitle(commit.sha));
    expect(await screen.findByText("app.ts")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("tab", { name: "Project" }));

    // A panel that unmounted would come back folded, and would ask git again.
    expect(screen.getByText("app.ts")).toBeTruthy();
    expect(http.fetchJson).toHaveBeenCalledTimes(1);
  });
});

describe("WorktreePanel: a failed setup script", () => {
  it("says nothing when the checkout was built cleanly", () => {
    renderPanel(STATE);

    expect(screen.queryByText("Setup script failed")).toBeNull();
  });

  it("warns above the tabs, so no tab can hide it", async () => {
    renderPanel({
      ...STATE,
      setupFailure: {
        exitCode: 127,
        output: "sh: 1: npm: not found",
        failedAt: new Date().toISOString(),
      },
    });

    expect(screen.getByText("Setup script failed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show the setup script's error" }));

    expect(await screen.findByText("Exit 127")).toBeTruthy();
    expect(screen.getByText(/npm: not found/)).toBeTruthy();
  });
});
