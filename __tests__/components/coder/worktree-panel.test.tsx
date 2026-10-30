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
  FileBrowser: ({ onOpenFile }: { onOpenFile?: (entry: FileEntry) => void }) => (
    <button
      type="button"
      onClick={() =>
        onOpenFile?.({
          name: "notes.md",
          path: "worktrees/saale/c-1/notes.md",
          kind: "file",
          size: 12,
          modified: 0,
          writable: true,
        })
      }
    >
      open notes
    </button>
  ),
}));
vi.mock("@/components/files/file-view", () => ({
  FileView: ({ entry }: { entry: FileEntry }) => <div data-testid="file-view">{entry.name}</div>,
}));

import { WorktreePanel } from "@/components/coder/worktree-panel";
import type { CoderSessionState } from "@/components/coder/use-coder-data";
import type { FileEntry } from "@/lib/files/types";

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

const PANEL_PROPS = {
  pullRequest: null,
  onLoadMoreCommits: () => {},
  loadingMoreCommits: false,
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
      {...PANEL_PROPS}
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
    refs: [],
    pushed: true,
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

  it("shows a committed image instead of its binary note", async () => {
    http.fetchJson.mockImplementation((url: string) =>
      url.includes("path=")
        ? Promise.resolve({
            path: "shots/a.png",
            binary: true,
            original: null,
            modified: null,
            preview: { sha: commit.sha, path: "shots/a.png" },
          })
        : Promise.resolve({
            files: [
              { path: "shots/a.png", originalPath: null, status: "A", added: null, deleted: null },
            ],
          }),
    );
    renderPanel({ ...STATE, commits: [commit] });

    fireEvent.click(screen.getByTitle(commit.sha));
    fireEvent.click(await screen.findByText("a.png"));

    const image = await screen.findByRole("img", { name: "a.png" });
    expect(image).toHaveAttribute(
      "src",
      `/api/coder/sessions/s-1/blob?path=shots%2Fa.png&sha=${commit.sha}`,
    );
    expect(screen.queryByText("Binary file")).toBeNull();
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

describe("WorktreePanel: a file from the Files tab", () => {
  it("opens it as a tab in the panel, and closes back to the browser", async () => {
    renderPanel(STATE);

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "open notes" }));

    // The editor gets the panel's width, which a sheet would not.
    expect(await screen.findByTestId("file-view")).toHaveTextContent("notes.md");
    expect(screen.getByRole("tab", { name: /notes\.md/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close the file tab" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download notes.md" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close the file tab" }));

    expect(screen.queryByTestId("file-view")).toBeNull();
    expect(screen.getByRole("button", { name: "open notes" })).toBeTruthy();
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
