// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFileTabs } from "@/components/files/use-file-tabs";
import type { FileEntry } from "@/lib/files/types";

function file(path: string): FileEntry {
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    kind: "file",
    size: 1,
    modified: 0,
    writable: true,
  };
}

describe("useFileTabs", () => {
  it("opens each file once and brings it to the front", () => {
    const { result } = renderHook(() => useFileTabs());

    act(() => result.current.open("user", file("/w/a.md")));
    act(() => result.current.open("user", file("/w/b.md")));
    act(() => result.current.open("user", file("/w/a.md")));

    expect(result.current.files.map((entry) => entry.entry.name)).toEqual(["a.md", "b.md"]);
    expect(result.current.active?.entry.name).toBe("a.md");
  });

  it("keeps the same path on two machines apart", () => {
    const { result } = renderHook(() => useFileTabs());

    act(() => result.current.open("user", file("/w/notes.md")));
    act(() => result.current.open("machine:one", file("/w/notes.md")));

    expect(result.current.files).toHaveLength(2);
    expect(result.current.active?.target).toBe("machine:one");
  });

  it("hands the front to the tab on the left when the active one closes", () => {
    const { result } = renderHook(() => useFileTabs());

    act(() => result.current.open("user", file("/w/a.md")));
    act(() => result.current.open("user", file("/w/b.md")));
    act(() => result.current.open("user", file("/w/c.md")));

    act(() => result.current.close("user:/w/c.md"));
    expect(result.current.active?.entry.name).toBe("b.md");

    act(() => result.current.close("user:/w/b.md"));
    act(() => result.current.close("user:/w/a.md"));
    expect(result.current.files).toHaveLength(0);
    expect(result.current.activeId).toBeNull();
  });

  it("reports which tabs hold unsaved text, and forgets a closed one", () => {
    const { result } = renderHook(() => useFileTabs());

    act(() => result.current.open("user", file("/w/a.md")));
    act(() => result.current.setDirty("user:/w/a.md", true));
    expect(result.current.dirty.has("user:/w/a.md")).toBe(true);

    act(() => result.current.close("user:/w/a.md"));
    expect(result.current.dirty.size).toBe(0);
  });
});
