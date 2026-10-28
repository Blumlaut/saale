// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@/lib/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http")>()),
  postJson: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

import { postJson, type FetchError } from "@/lib/http";
import { toast } from "sonner";
import { useFileSave } from "@/components/files/use-file-save";

const PATH = "/workspaces/user/notes.md";
const MTIME = 1_791_904_714_445;

function renderSave(overrides: Partial<Parameters<typeof useFileSave>[0]> = {}) {
  const onSaved = vi.fn();
  const view = renderHook((props: Parameters<typeof useFileSave>[0]) => useFileSave(props), {
    initialProps: {
      target: "user",
      path: PATH,
      baseModified: MTIME,
      enabled: true,
      saved: "# notes",
      onSaved,
      ...overrides,
    },
  });
  return { ...view, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useFileSave", () => {
  it("sends the whole buffer and clears the unsaved mark", async () => {
    vi.mocked(postJson).mockResolvedValue({ path: PATH, size: 9, modified: MTIME + 1 });
    const { result, onSaved } = renderSave();

    act(() => result.current.onChange("edited"));
    expect(result.current.dirty).toBe(true);

    await act(async () => result.current.save());

    expect(postJson).toHaveBeenCalledWith("/api/files/write?target=user", {
      path: PATH,
      content: "edited",
      baseModified: MTIME,
    });
    expect(onSaved).toHaveBeenCalledWith("edited", MTIME + 1);
    expect(result.current.dirty).toBe(false);
  });

  it("treats an unchanged file as clean", () => {
    const { result } = renderSave();

    act(() => result.current.onChange("# notes"));

    expect(result.current.dirty).toBe(false);
  });

  it("offers an overwrite when something wrote the file since it was read", async () => {
    const stale = Object.assign(new Error("notes.md changed on disk since you opened it"), {
      status: 409,
      code: "modified",
    }) as FetchError;
    vi.mocked(postJson)
      .mockRejectedValueOnce(stale)
      .mockResolvedValue({
        path: PATH,
        size: 7,
        modified: MTIME + 2,
      });
    const { result, onSaved } = renderSave();

    act(() => result.current.onChange("edited"));
    await act(async () => result.current.save());

    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(true);
    const warning = vi.mocked(toast.warning).mock.calls[0];
    expect(warning?.[0]).toBe("This file changed on disk");

    const action = (warning?.[1] as unknown as { action: { onClick: () => void } }).action;
    await act(async () => action.onClick());

    expect(vi.mocked(postJson).mock.calls[1]?.[1]).toMatchObject({
      content: "edited",
      force: true,
    });
    expect(onSaved).toHaveBeenCalledWith("edited", MTIME + 2);
  });

  it("reports a save that failed for another reason", async () => {
    vi.mocked(postJson).mockRejectedValue(new Error("Workspace unavailable"));
    const { result } = renderSave();

    act(() => result.current.onChange("edited"));
    await act(async () => result.current.save());

    expect(result.current.error).toBe("Workspace unavailable");
    expect(result.current.dirty).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("saves nothing while the workspace is read-only", async () => {
    const { result } = renderSave({ enabled: false });

    act(() => result.current.onChange("edited"));
    await act(async () => result.current.save());

    expect(postJson).not.toHaveBeenCalled();
  });
});
