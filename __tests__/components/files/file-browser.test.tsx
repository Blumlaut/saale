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

vi.mock("@/lib/files/upload-client", () => ({ uploadFile: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { fetchJson } from "@/lib/http";
import { uploadFile } from "@/lib/files/upload-client";
import { toast } from "sonner";
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
      capabilities: {
        upload: true,
        createFile: true,
        createDirectory: true,
        rename: true,
        remove: true,
      },
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

/** Answer each listing request with the folder that was asked for. */
function listingPerRequest() {
  vi.mocked(fetchJson).mockImplementation(async (url: string) => {
    const asked = new URL(url, "http://localhost").searchParams.get("path") ?? ROOT;
    const path = asked.startsWith("/") ? asked : `${ROOT}/${asked}`;
    const base = listing({ path });
    return {
      ...base,
      entries: base.entries.map((entry) => ({ ...entry, path: `${path}/${entry.name}` })),
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(fetchJson).mockResolvedValue(listing());
});

describe("FileBrowser", () => {
  it("shows the workspace's own label as context and lists its rows", async () => {
    renderBrowser();

    expect(await screen.findByText("artifacts")).toBeInTheDocument();
    expect(screen.getByText("report.md")).toBeInTheDocument();
    // The label comes from the API, not from the caller  that is what makes
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

    // From the anchor to the clicked row, inclusive  all three.
    expect(await screen.findByText("3 selected")).toBeInTheDocument();
  });

  it("shows how far an upload has got", async () => {
    let land: (result: { ok: true; name: string }) => void = () => {};
    vi.mocked(uploadFile).mockImplementation(async (file, options) => {
      options.onProgress?.({ name: file.name, sent: 512, total: 1024, index: 1, count: 1 });
      return new Promise((resolve) => {
        land = resolve;
      });
    });

    const { container } = renderBrowser();
    await screen.findByText("artifacts");

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "snapshot.tar", { type: "application/x-tar" })] },
    });

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("snapshot.tar");
    expect(status).toHaveTextContent("50%");
    // The browser knows which workspace and folder it is uploading into.
    expect(vi.mocked(uploadFile).mock.calls[0]?.[1]).toMatchObject({
      target: "council:c1",
      dir: ROOT,
    });

    land({ ok: true, name: "snapshot.tar" });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("offers an overwrite when the name is taken", async () => {
    vi.mocked(uploadFile).mockResolvedValueOnce({
      ok: false,
      name: "notes.md",
      reason: "exists",
      message: "1 file(s) already exist",
    });

    const { container } = renderBrowser();
    await screen.findByText("artifacts");

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["new"], "notes.md", { type: "text/markdown" })] },
    });

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith("1 file already exists here", expect.anything());
    });
    const options = vi.mocked(toast.warning).mock.calls[0]?.[1] as
      { action?: { label?: string } } | undefined;
    expect(options?.action?.label).toBe("Overwrite");
  });

  it("keeps the occasional actions in the menu", async () => {
    renderBrowser();
    await screen.findByText("artifacts");

    // Nothing but the trail, a refresh and the upload sit in the toolbar.
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));

    expect(await screen.findByRole("menuitem", { name: "New folder" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Select all" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Show hidden files" })).toBeInTheDocument();
  });

  it("remembers that hidden files were asked for", async () => {
    const first = renderBrowser();
    await screen.findByText("artifacts");
    expect(vi.mocked(fetchJson).mock.calls[0]?.[0]).toContain("hideDotfiles=1");

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Show hidden files" }));
    await waitFor(() => {
      expect(vi.mocked(fetchJson).mock.calls.at(-1)?.[0]).toContain("hideDotfiles=0");
    });

    first.unmount();
    vi.mocked(fetchJson).mockClear();
    renderBrowser();

    await screen.findByText("artifacts");
    expect(vi.mocked(fetchJson).mock.calls[0]?.[0]).toContain("hideDotfiles=0");
  });

  it("goes home to the folder it was opened at", async () => {
    listingPerRequest();
    render(<FileBrowser target="user" rootPath="worktrees/c-1a2b3c4d" />);

    // At the worktree root there is nowhere to go back to.
    await screen.findByText("artifacts");
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Up one folder" })).toBeNull();

    fireEvent.click(screen.getByText("artifacts"));
    const home = `${ROOT}/worktrees/c-1a2b3c4d`;
    await waitFor(() => {
      expect(vi.mocked(fetchJson).mock.calls.at(-1)?.[0]).toContain(
        `path=${encodeURIComponent(`${home}/artifacts`)}`,
      );
    });

    fireEvent.click(await screen.findByRole("button", { name: "Home" }));

    await waitFor(() => {
      expect(vi.mocked(fetchJson).mock.calls.at(-1)?.[0]).toContain(
        `path=${encodeURIComponent(home)}`,
      );
    });
  });

  it("starts over at a new root when the caller hands over another worktree", async () => {
    listingPerRequest();
    const view = render(<FileBrowser target="user" rootPath="worktrees/c-1a2b3c4d" />);
    await screen.findByText("artifacts");

    view.rerender(<FileBrowser target="user" rootPath="worktrees/c-2b3c4d5e" />);

    await waitFor(() => {
      expect(vi.mocked(fetchJson).mock.calls.at(-1)?.[0]).toContain(
        `path=${encodeURIComponent("worktrees/c-2b3c4d5e")}`,
      );
    });
    // The new worktree is home, so there is nowhere above it.
    expect(screen.queryByRole("button", { name: "Up one folder" })).toBeNull();
  });

  it("stays in the folder it is filtering when hidden files are toggled", async () => {
    listingPerRequest();
    render(<FileBrowser target="user" rootPath="worktrees/c-1a2b3c4d" />);

    fireEvent.click(await screen.findByText("artifacts"));
    const folder = `${ROOT}/worktrees/c-1a2b3c4d/artifacts`;
    await waitFor(() => {
      expect(vi.mocked(fetchJson).mock.calls.at(-1)?.[0]).toContain(
        `path=${encodeURIComponent(folder)}`,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Show hidden files" }));

    await waitFor(() => {
      const lastCall = vi.mocked(fetchJson).mock.calls.at(-1)?.[0] ?? "";
      expect(lastCall).toContain("hideDotfiles=0");
      expect(lastCall).toContain(`path=${encodeURIComponent(folder)}`);
    });
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

  it("hands a file to the host instead of opening the viewer", async () => {
    const onOpenFile = vi.fn();
    render(<FileBrowser target="council:c1" onOpenFile={onOpenFile} />);

    fireEvent.click(await screen.findByText("report.md"));

    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: `${ROOT}/report.md` }));
    // The host shows it somewhere it can be widened, so no sheet here.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks a listing that was cut off", async () => {
    vi.mocked(fetchJson).mockResolvedValue(listing({ truncated: true }));

    renderBrowser();

    expect(await screen.findByText(/Showing the first 3 entries/)).toBeInTheDocument();
  });
});
