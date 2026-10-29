// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http")>()),
  postJson: vi.fn(),
}));

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

vi.mock("@/components/editor/monaco-view", () => ({
  MonacoView: ({
    content,
    onContentChange,
  }: {
    content: string;
    onContentChange: (content: string) => void;
  }) => (
    <textarea
      aria-label="editor"
      defaultValue={content}
      onChange={(e) => onContentChange(e.target.value)}
    />
  ),
}));

import { postJson } from "@/lib/http";
import { FileView } from "@/components/files/file-view";
import type { FileEntry } from "@/lib/files/types";

const PATH = "/home/u1a2b3c4/notes.md";
/** The row's mtime, from a listing read before the file was last written. */
const LISTED = 1_791_904_714_445;
/** The mtime the bytes on screen were actually served at. */
const SERVED = LISTED + 5_000;

const entry: FileEntry = {
  name: "notes.md",
  path: PATH,
  kind: "file",
  size: 7,
  modified: LISTED,
  writable: true,
};

function serveFile(text = "# notes", modified = SERVED) {
  const fetchMock = vi.fn(async () => {
    return new Response(text, { headers: { "x-file-modified": String(modified) } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("FileView", () => {
  it("checks a save against the mtime its text was read at", async () => {
    serveFile();
    vi.mocked(postJson).mockResolvedValue({ path: PATH, size: 8, modified: SERVED + 1 });

    render(<FileView target="user" entry={entry} />);

    const editor = await screen.findByLabelText("editor");
    fireEvent.change(editor, { target: { value: "# edited" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(postJson).toHaveBeenCalled());
    expect(vi.mocked(postJson).mock.calls[0]?.[1]).toMatchObject({
      path: PATH,
      content: "# edited",
      baseModified: SERVED,
    });
  });

  it("falls back to the listed mtime when the read reports none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# notes")),
    );
    vi.mocked(postJson).mockResolvedValue({ path: PATH, size: 8, modified: LISTED + 1 });

    render(<FileView target="user" entry={entry} />);

    const editor = await screen.findByLabelText("editor");
    fireEvent.change(editor, { target: { value: "# edited" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(postJson).toHaveBeenCalled());
    expect(vi.mocked(postJson).mock.calls[0]?.[1]).toMatchObject({ baseModified: LISTED });
  });
});
