// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockFetchJson = vi.fn();
const mockPatchJson = vi.fn();
vi.mock("@/lib/http", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
  patchJson: (...args: unknown[]) => mockPatchJson(...args),
}));

import { useChatSessionState } from "@/components/chat/use-chat-session-state";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useChatSessionState", () => {
  it("applySession applies server metadata (model, thinking, tools)", () => {
    const { result } = renderHook(() => useChatSessionState("sess-1"));

    act(() => {
      result.current.applySession({
        modelProvider: "openai",
        modelName: "gpt-4o",
        thinkingLevel: "high",
        toolConfig: { mail: false },
      });
    });

    expect(result.current.modelId).toBe("openai/gpt-4o");
    expect(result.current.thinkingLevel).toBe("high");
    expect(result.current.toolConfig).toMatchObject({ mail: false });
  });

  it("applySession does NOT echo server data back as a redundant PATCH", async () => {
    const { result } = renderHook(() => useChatSessionState("sess-1"));

    act(() => {
      result.current.applySession({ modelProvider: "openai", modelName: "gpt-4o" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockPatchJson).not.toHaveBeenCalled();
  });

  it("debounces a user model change into one PATCH", async () => {
    const { result } = renderHook(() => useChatSessionState("sess-1"));

    act(() => {
      result.current.setModelId("openai/gpt-4o");
    });
    // Changing again inside the debounce window cancels the first timer.
    act(() => {
      result.current.setModelId("anthropic/claude-sonnet-4");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockPatchJson).toHaveBeenCalledTimes(1);
    expect(mockPatchJson).toHaveBeenCalledWith("/api/chat/sessions/sess-1", {
      modelProvider: "anthropic",
      modelName: "claude-sonnet-4",
      thinkingLevel: "off",
    });
  });

  it("loadSessionTitle fetches and stores the session title", async () => {
    mockFetchJson.mockResolvedValueOnce({ session: { title: "My Chat" } });
    const { result } = renderHook(() => useChatSessionState("sess-1"));

    await act(async () => {
      await result.current.loadSessionTitle();
    });

    expect(result.current.sessionTitle).toBe("My Chat");
  });

  it("saveTitle sanitizes, patches and notifies other tabs", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const { result } = renderHook(() => useChatSessionState("sess-1"));

    await act(async () => {
      await result.current.saveTitle("  My\x00 New Title  ");
    });

    expect(mockPatchJson).toHaveBeenCalledWith("/api/chat/sessions/sess-1", {
      title: "My New Title",
    });
    expect(result.current.sessionTitle).toBe("My New Title");
    expect(result.current.editingTitle).toBe(false);
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "chat-renamed" }));
  });

  it("saveTitle ignores empty titles without patching", async () => {
    const { result } = renderHook(() => useChatSessionState("sess-1"));
    await act(async () => {
      await result.current.saveTitle("   ");
    });
    expect(mockPatchJson).not.toHaveBeenCalled();
  });

  it("toggleTool flips the category and persists", async () => {
    const { result } = renderHook(() => useChatSessionState("sess-1"));
    const before = result.current.toolConfig.mail;

    await act(async () => {
      await result.current.toggleTool("mail");
    });

    expect(result.current.toolConfig.mail).toBe(!before);
    expect(mockPatchJson).toHaveBeenCalledWith("/api/chat/sessions/sess-1", {
      toolConfig: expect.objectContaining({ mail: !before }),
    });
  });

  it("surfaces a 404 title fetch without throwing", async () => {
    mockFetchJson.mockRejectedValueOnce(new Error("Not found"));
    const { result } = renderHook(() => useChatSessionState("sess-1"));
    await act(async () => {
      await result.current.loadSessionTitle();
    });
    expect(result.current.sessionTitle).toBe("");
  });
});
