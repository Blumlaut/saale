// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { downloadFile } from "@/lib/download";

/**
 * Downloads have to leave the app document alone.
 *
 * A same-window anchor click is what left Firefox for Android (custom tabs and
 * installed web apps) on about:blank with the app replaced  bugzilla 1919827
 * and 1953287, both still open. The helper therefore routes the request through
 * a hidden frame instead: the navigation happens in a nested context the user
 * never sees.
 */
describe("downloadFile", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  const frames = () => [...document.body.querySelectorAll("iframe")];

  it("routes the request through a hidden, inert frame", () => {
    downloadFile("/api/chat/workspace-files?file=reports%2Fq3.pdf&download=1");

    const [frame] = frames();
    expect(frame).toBeDefined();
    expect(frame!.getAttribute("src")).toBe(
      "/api/chat/workspace-files?file=reports%2Fq3.pdf&download=1",
    );
    expect(frame!.hidden).toBe(true);
    expect(frame!.getAttribute("aria-hidden")).toBe("true");
    // Nothing else is navigated or clicked: the app keeps its document.
    expect(document.body.querySelector("a")).toBeNull();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("leaves the frame in place long enough for the transfer to start, then drops it", () => {
    vi.useFakeTimers();

    downloadFile("/api/chat/attachments/att-1");
    expect(frames()).toHaveLength(1);

    // The download is still running: removing the frame this early can abort it.
    vi.advanceTimersByTime(9_000);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.getAttribute("src")).toBe("/api/chat/attachments/att-1");

    vi.advanceTimersByTime(60_000);
    expect(frames()).toHaveLength(0);
  });

  it("keeps repeated downloads independent (edge case)", () => {
    vi.useFakeTimers();

    downloadFile("/api/chat/attachments/att-1");
    vi.advanceTimersByTime(30_000);
    downloadFile("/api/chat/attachments/att-2");

    // The second click must not cancel the first transfer by reusing its frame.
    expect(frames().map((f) => f.getAttribute("src"))).toEqual([
      "/api/chat/attachments/att-1",
      "/api/chat/attachments/att-2",
    ]);

    vi.advanceTimersByTime(31_000);
    expect(frames().map((f) => f.getAttribute("src"))).toEqual(["/api/chat/attachments/att-2"]);
  });

  it("does nothing without a document (server render)", () => {
    const doc = globalThis.document;
    // @ts-expect-error  simulating the server render, where there is no DOM.
    delete globalThis.document;

    try {
      expect(() => downloadFile("/api/chat/attachments/att-1")).not.toThrow();
    } finally {
      globalThis.document = doc;
    }

    expect(frames()).toHaveLength(0);
  });
});
