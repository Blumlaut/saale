// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatSeen } from "@/hooks/use-chat-seen";

/**
 * A hidden tab must report nothing: that is what lets a reply land as a push on
 * the device the user walked away from.
 */

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

describe("useChatSeen", () => {
  beforeEach(() => {
    setVisibility("visible");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the chat as soon as it is on screen", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useChatSeen("chat-1"));

    expect(fetchMock).toHaveBeenCalledWith("/api/chat/sessions/chat-1/seen", { method: "POST" });
  });

  it("reports nothing from a hidden tab", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    setVisibility("hidden");

    renderHook(() => useChatSeen("chat-1"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports again when the tab comes back to the front", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useChatSeen("chat-1"));
    setVisibility("hidden");
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hands the caller a reporter for a finished turn", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChatSeen("chat-1"));
    act(() => result.current());

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs a failed report instead of throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    renderHook(() => useChatSeen("chat-1"));

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
  });
});
