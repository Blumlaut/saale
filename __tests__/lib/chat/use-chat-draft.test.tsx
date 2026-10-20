// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { renderHook, act } from "@testing-library/react";
import { useChatDraft } from "@/hooks/use-chat-draft";
import { draftStorageKey, loadDraft } from "@/lib/chat/draft";
import { installMemoryStorage } from "../../helpers/memory-storage";

/**
 * The hook is what makes the composer survive navigation: the draft is read
 * back on mount, written on a debounce, and flushed on the way out  so the
 * last characters typed before navigating away are not lost.
 */

function store(text: string, updatedAt = 1) {
  window.localStorage.setItem(draftStorageKey("session-a"), JSON.stringify({ text, updatedAt }));
}

beforeEach(() => {
  installMemoryStorage(window as unknown as Record<string, unknown>);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useChatDraft", () => {
  it("restores the stored draft for the session", () => {
    store("half-typed");

    const { result } = renderHook(() => useChatDraft("session-a"));

    expect(result.current.draft).toBe("half-typed");
  });

  it("keeps drafts separate per session", () => {
    store("session a draft");
    window.localStorage.setItem(
      draftStorageKey("session-b"),
      JSON.stringify({ text: "session b draft", updatedAt: 1 }),
    );

    const { result, rerender } = renderHook(({ id }) => useChatDraft(id), {
      initialProps: { id: "session-a" },
    });
    expect(result.current.draft).toBe("session a draft");

    rerender({ id: "session-b" });

    expect(result.current.draft).toBe("session b draft");
  });

  it("persists edits after the debounce", () => {
    const { result } = renderHook(() => useChatDraft("session-a"));

    act(() => {
      result.current.setDraft("new text");
    });

    // Nothing written yet  keystrokes stay off localStorage's sync path.
    expect(window.localStorage.getItem(draftStorageKey("session-a"))).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(JSON.parse(window.localStorage.getItem(draftStorageKey("session-a"))!)).toMatchObject({
      text: "new text",
    });
  });

  it("flushes the draft when the composer unmounts", () => {
    const { result, unmount } = renderHook(() => useChatDraft("session-a"));

    act(() => {
      result.current.setDraft("typed then left");
    });
    unmount();

    expect(JSON.parse(window.localStorage.getItem(draftStorageKey("session-a"))!).text).toBe(
      "typed then left",
    );
  });

  it("removes the stored draft when the composer is cleared", () => {
    store("old draft");
    const { result } = renderHook(() => useChatDraft("session-a"));

    act(() => {
      result.current.setDraft("");
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(window.localStorage.getItem(draftStorageKey("session-a"))).toBeNull();
  });

  it("keeps the stored draft through a StrictMode mount cycle", () => {
    // StrictMode unmounts and remounts every effect on mount; the flush must
    // not treat that as "the user cleared the composer" and erase the draft.
    store("keep me");
    const { result, unmount } = renderHook(() => useChatDraft("session-a"), {
      wrapper: StrictMode,
    });

    expect(result.current.draft).toBe("keep me");
    unmount();
    expect(loadDraft("session-a")).toBe("keep me");
  });

  it("persists the draft of the session being left", () => {
    const { result, rerender } = renderHook(({ id }) => useChatDraft(id), {
      initialProps: { id: "session-a" },
    });

    act(() => {
      result.current.setDraft("typed for a");
    });
    rerender({ id: "session-b" }); // before the debounce fires

    expect(loadDraft("session-a")).toBe("typed for a");
    expect(result.current.draft).toBe("");
  });

  it("never writes one session's text into another session's draft", () => {
    const { result, rerender } = renderHook(({ id }) => useChatDraft(id), {
      initialProps: { id: "session-a" },
    });

    act(() => {
      result.current.setDraft("typed for a");
    });
    rerender({ id: "session-b" });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(window.localStorage.getItem(draftStorageKey("session-b"))).toBeNull();
  });

  it("does not let another tab overwrite the text being typed", () => {
    // Regression: a second tab on the same chat used to live-sync its draft
    // into this composer, replacing whatever was already typed here.
    const { result } = renderHook(() => useChatDraft("session-a"));

    act(() => {
      result.current.setDraft("my own sentence");
    });

    act(() => {
      store("from the other tab", 2);
      window.dispatchEvent(new StorageEvent("storage", { key: draftStorageKey("session-a") }));
    });

    expect(result.current.draft).toBe("my own sentence");
  });

  it("adopts a draft another tab wrote when the chat is opened", () => {
    window.localStorage.setItem(
      draftStorageKey("session-b"),
      JSON.stringify({ text: "written elsewhere", updatedAt: 2 }),
    );

    const { result, rerender } = renderHook(({ id }) => useChatDraft(id), {
      initialProps: { id: "session-a" },
    });
    expect(result.current.draft).toBe("");

    rerender({ id: "session-b" });

    expect(result.current.draft).toBe("written elsewhere");
  });
});
