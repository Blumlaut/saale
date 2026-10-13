// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http")>()),
  fetchJson: vi.fn(),
  postJson: vi.fn(),
}));

vi.mock("@/lib/download", () => ({ downloadFile: vi.fn() }));

import { fetchJson } from "@/lib/http";
import { downloadFile } from "@/lib/download";
import { FileBrowser } from "@/components/files/file-browser";
import type { FileListing } from "@/lib/files/types";

const ROOT = "/home/u1a2b3c4";

function listing(overrides: Partial<FileListing> = {}): FileListing {
  return {
    target: {
      id: "council:c1",
      label: "Launch review",
      root: ROOT,
      capabilities: { upload: true, createDirectory: true, rename: true, remove: true },
    },
    path: ROOT,
    truncated: false,
    entries: [
      {
        name: "artifacts",
        path: `${ROOT}/artifacts`,
        kind: "directory",
        size: 4096,
        modified: 1_791_904_714_445,
        writable: true,
      },
      {
        name: "report.md",
        path: `${ROOT}/report.md`,
        kind: "file",
        size: 2048,
        modified: 1_791_904_714_445,
        writable: true,
      },
      {
        name: "notes.txt",
        path: `${ROOT}/notes.txt`,
        kind: "file",
        size: 12,
        modified: 1_791_904_714_445,
        writable: true,
      },
    ],
    ...overrides,
  };
}

function renderBrowser() {
  return render(<FileBrowser target="council:c1" emptyHint="Members write here as they work." />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchJson).mockResolvedValue(listing());
});

describe("FileBrowser", () => {
  it("shows the workspace's own label as context and lists its rows", async () => {
    renderBrowser();

    expect(await screen.findByText("artifacts")).toBeInTheDocument();
    expect(screen.getByText("report.md")).toBeInTheDocument();
    // The label comes from the API, not from the caller — that is what makes
    // the same component work for any workspace.
    expect(screen.getAllByText("Launch review").length).toBeGreaterThan(0);
    expect(vi.mocked(fetchJson).mock.calls[0]?.[0]).toContain("target=council%3Ac1");
  });

  it("opens a folder by listing it", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByText("artifacts"));

    await waitFor(() => {
      const lastCall = vi.mocked(fetchJson).mock.calls.at(-1)?.[0] ?? "";
      expect(lastCall).toContain(`path=${encodeURIComponent(`${ROOT}/artifacts`)}`);
    });
  });

  it("downloads a single selected file directly and a mixed selection as a zip", async () => {
    renderBrowser();

    fireEvent.click(await screen.findByLabelText("Select report.md"));
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Download/ }));

    expect(downloadFile).toHaveBeenCalledWith(
      expect.stringContaining(
        `/api/files/raw?target=council%3Ac1&path=${encodeURIComponent(`${ROOT}/report.md`)}&download=1`,
      ),
    );

    // Adding a folder switches the action to an archive of the whole selection.
    fireEvent.click(screen.getByLabelText("Select artifacts"));
    expect(await screen.findByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Download zip/ }));

    const zipUrl = vi.mocked(downloadFile).mock.calls.at(-1)?.[0] ?? "";
    expect(zipUrl).toContain("/api/files/zip?");
    expect(zipUrl).toContain(`path=${encodeURIComponent(`${ROOT}/report.md`)}`);
    expect(zipUrl).toContain(`path=${encodeURIComponent(`${ROOT}/artifacts`)}`);
  });

  it("extends a selection with shift-click", async () => {
    renderBrowser();

    fireEvent.click(await screen.findByLabelText("Select artifacts"));
    fireEvent.click(screen.getByText("notes.txt"), { shiftKey: true });

    // From the anchor to the clicked row, inclusive — all three.
    expect(await screen.findByText("3 selected")).toBeInTheDocument();
  });

  it("says so when the workspace is empty", async () => {
    vi.mocked(fetchJson).mockResolvedValue(listing({ entries: [] }));

    renderBrowser();

    expect(await screen.findByText("Nothing here yet.")).toBeInTheDocument();
    expect(screen.getByText("Members write here as they work.")).toBeInTheDocument();
  });

  it("offers a retry when the workspace cannot be listed", async () => {
    vi.mocked(fetchJson).mockRejectedValueOnce(new Error("Council workspaces need Open Terminal."));

    renderBrowser();

    expect(await screen.findByText("Council workspaces need Open Terminal.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("marks a listing that was cut off", async () => {
    vi.mocked(fetchJson).mockResolvedValue(listing({ truncated: true }));

    renderBrowser();

    expect(await screen.findByText(/Showing the first 3 entries/)).toBeInTheDocument();
  });
});
