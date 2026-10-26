// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, renderHook, render, waitFor } from "@testing-library/react";
import {
  resetCurrentUserImage,
  setCurrentUserImage,
  useCurrentUserImage,
} from "@/hooks/use-current-user-image";
import { UserAvatar } from "@/components/profile/user-avatar";

/** The session route is the one source of the signed-in user's picture. */

function sessionResponse(image: string | null) {
  return { ok: true, status: 200, json: async () => ({ user: { image } }) };
}

describe("useCurrentUserImage", () => {
  beforeEach(() => {
    resetCurrentUserImage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the picture from the session once for every avatar", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sessionResponse("/api/profile/avatar/u1?v=7"));
    vi.stubGlobal("fetch", fetchMock);

    const first = renderHook(() => useCurrentUserImage());
    const second = renderHook(() => useCurrentUserImage());

    await waitFor(() => expect(first.result.current).toBe("/api/profile/avatar/u1?v=7"));
    expect(second.result.current).toBe("/api/profile/avatar/u1?v=7");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows an uploaded picture on avatars that are already mounted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sessionResponse(null)));

    const { result } = renderHook(() => useCurrentUserImage());
    await waitFor(() => expect(result.current).toBeNull());

    act(() => setCurrentUserImage("/api/profile/avatar/u1?v=8"));

    await waitFor(() => expect(result.current).toBe("/api/profile/avatar/u1?v=8"));
  });

  it("reports no picture when the session cannot be read, and asks again", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCurrentUserImage());
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(result.current).toBeNull();

    fetchMock.mockResolvedValue(sessionResponse("/api/profile/avatar/u1?v=9"));
    const retry = renderHook(() => useCurrentUserImage());

    await waitFor(() => expect(retry.result.current).toBe("/api/profile/avatar/u1?v=9"));
    errorSpy.mockRestore();
  });
});

describe("UserAvatar", () => {
  beforeEach(() => {
    resetCurrentUserImage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("draws the picture the session carries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sessionResponse("/api/profile/avatar/u1?v=7")),
    );
    stubLoadedImages();

    const { container } = render(<UserAvatar className="h-8 w-8" />);

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "/api/profile/avatar/u1?v=7",
      ),
    );
  });

  it("falls back to an outline icon without a picture", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sessionResponse(null)));

    const { container } = render(<UserAvatar className="h-8 w-8" />);

    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
    expect(container.querySelector("img")).toBeNull();
  });
});

/** jsdom never fires image loads, so the avatar's preloader is stood in for. */
function stubLoadedImages(): void {
  class LoadedImage {
    src = "";
    complete = true;
    naturalWidth = 1;
    crossOrigin: string | null = null;
    referrerPolicy = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
  }

  vi.stubGlobal("Image", LoadedImage);
}
