// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const { mockUsePathname } = vi.hoisted(() => ({ mockUsePathname: vi.fn() }));

vi.mock("next/navigation", () => ({ usePathname: () => mockUsePathname() }));

import { PushSeenReporter } from "@/components/providers/push-seen-reporter";

/**
 * A page on screen is what calls off a notification's phone copy. A hidden tab
 * reports nothing: nobody is reading it.
 */

/** The API answers `{ ok: true }`, which `postJson` reads. */
function seenResponse() {
  return { ok: true, json: async () => ({ ok: true }) };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

describe("PushSeenReporter", () => {
  beforeEach(() => {
    setVisibility("visible");
    mockUsePathname.mockReturnValue("/dashboard/chat/chat-1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the page as soon as it is on screen", () => {
    const fetchMock = vi.fn().mockResolvedValue(seenResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<PushSeenReporter />);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/seen",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "/dashboard/chat/chat-1" }),
      }),
    );
  });

  it("reports the page the user moves to", () => {
    const fetchMock = vi.fn().mockResolvedValue(seenResponse());
    vi.stubGlobal("fetch", fetchMock);

    mockUsePathname.mockReturnValue("/dashboard/mail");
    render(<PushSeenReporter />);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/seen",
      expect.objectContaining({ body: JSON.stringify({ url: "/dashboard/mail" }) }),
    );
  });

  it("reports nothing from a hidden tab", () => {
    const fetchMock = vi.fn().mockResolvedValue(seenResponse());
    vi.stubGlobal("fetch", fetchMock);
    setVisibility("hidden");

    render(<PushSeenReporter />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports again when the tab comes back to the front", () => {
    const fetchMock = vi.fn().mockResolvedValue(seenResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<PushSeenReporter />);
    setVisibility("hidden");
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs a failed report instead of throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<PushSeenReporter />);

    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
  });
});
