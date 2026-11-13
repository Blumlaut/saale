// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { FilePreview } from "@/components/files/file-preview";
import type { FileEntry } from "@/lib/files/types";

const ROOT = "/home/u1a2b3c4";

const REPORT: FileEntry = {
  name: "report.pdf",
  path: `${ROOT}/report.pdf`,
  kind: "file",
  size: 2048,
  modified: 1_791_904_714_445,
  writable: true,
};

/** jsdom ships neither object URLs nor a fetch that a preview can use. */
function stubObjectUrls() {
  const createObjectURL = vi.fn(() => "blob:report");
  const revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

describe("FilePreview · pdf", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hands the bytes to the browser's viewer as an object URL", async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrls();
    const bytes = new Blob(["%PDF-1.7"], { type: "application/pdf" });
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { container, unmount } = render(<FilePreview target="user" entry={REPORT} kind="pdf" />);

    await waitFor(() => expect(screen.getByTitle("report.pdf")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/files/raw?${new URLSearchParams({ target: "user", path: REPORT.path }).toString()}`,
      expect.objectContaining({ cache: "no-store" }),
    );
    // Not a data URL or the endpoint's own: an object URL answers to no headers.
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const frame = container.querySelector("iframe");
    expect(frame).toHaveAttribute("src", "blob:report");

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
  });

  it("shows the server's reason when the file cannot be read", async () => {
    stubObjectUrls();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "report.pdf is too large to preview." }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    render(<FilePreview target="user" entry={REPORT} kind="pdf" />);

    expect(await screen.findByText("report.pdf is too large to preview.")).toBeInTheDocument();
    expect(screen.queryByTitle("report.pdf")).not.toBeInTheDocument();
  });
});
