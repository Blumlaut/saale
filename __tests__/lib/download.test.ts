// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { downloadFile } from "@/lib/download";

/**
 * Downloads have to leave the app document alone.
 *
 * A same-window anchor click is what left Firefox for Android (custom tabs and
 * installed web apps) on about:blank with the app replaced  bugzilla 1919827
 * and 1953287, both still open. The helper therefore routes the request through
 * a hidden frame instead: the navigation happens in a nested context the user
 * never sees.
 *
 * The frame is invisible, so the server's answer has to be read first. a shared
 * file is a path, and a path an agent wrote can be gone by the time the chat is
 * opened, which used to make the button do nothing at all.
 */

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

/** A response whose body we can watch being dropped. */
function response(status: number, init: { body?: string; type?: string } = {}) {
  const body = init.body ?? "";
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === "content-type" ? (init.type ?? null) : null) },
    body: { cancel: vi.fn(async () => {}) },
    text: vi.fn(async () => body),
  };
}

function stubFetch(...answers: Array<ReturnType<typeof response> | Error>) {
  const mock = vi.fn(async () => {
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("downloadFile", () => {
  beforeEach(() => {
    toastError.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const frames = () => [...document.body.querySelectorAll("iframe")];

  it("routes the request through a hidden, inert frame", async () => {
    stubFetch(response(200));

    await downloadFile("/api/chat/workspace-files?file=reports%2Fq3.pdf&download=1");

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
    expect(toastError).not.toHaveBeenCalled();
  });

  it("asks the server first, and drops the body it is answered with", async () => {
    const answer = response(200);
    stubFetch(answer);

    await downloadFile("/api/chat/attachments/att-1");

    // The check costs the headers, not the file: the frame fetches the bytes.
    expect(answer.body.cancel).toHaveBeenCalled();
  });

  it("says so when the file is gone instead of doing nothing", async () => {
    stubFetch(response(404));

    await downloadFile("/api/chat/workspace-files?file=shots%2Fgone.png&download=1");

    expect(frames()).toHaveLength(0);
    expect(toastError).toHaveBeenCalledWith("That file is no longer in the workspace");
  });

  it("reports any other refusal as a failed download", async () => {
    stubFetch(response(500));

    await downloadFile("/api/files/zip?dir=shots");

    expect(frames()).toHaveLength(0);
    expect(toastError).toHaveBeenCalledWith("Could not download that file");
  });
  it("reports a check that never reached the server", async () => {
    stubFetch(new Error("offline"));

    await downloadFile("/api/chat/attachments/att-1");

    expect(frames()).toHaveLength(0);
    expect(toastError).toHaveBeenCalledWith("Could not download that file");
  });

  it("passes on the reason the server gave", async () => {
    stubFetch(
      response(413, {
        type: "application/json; charset=utf-8",
        body: JSON.stringify({ error: "backup.img is 7.0 GB. Too large to serve here." }),
      }),
    );

    await downloadFile("/api/files/raw?path=%2Fbackup.img&download=1");

    expect(frames()).toHaveLength(0);
    expect(toastError).toHaveBeenCalledWith("backup.img is 7.0 GB. Too large to serve here.");
  });

  it("falls back to its own wording for a refusal it cannot read", async () => {
    stubFetch(response(502, { type: "text/html", body: "<html>Bad gateway</html>" }));

    await downloadFile("/api/files/zip?dir=shots");

    expect(toastError).toHaveBeenCalledWith("Could not download that file");
  });

  it("leaves the frame in place long enough for the transfer to start, then drops it", async () => {
    stubFetch(response(200));
    vi.useFakeTimers();

    void downloadFile("/api/chat/attachments/att-1");
    // The check answers on the next microtask, before the frame exists.
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toHaveLength(1);

    // The download is still running: removing the frame this early can abort it.
    vi.advanceTimersByTime(9_000);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.getAttribute("src")).toBe("/api/chat/attachments/att-1");

    vi.advanceTimersByTime(60_000);
    expect(frames()).toHaveLength(0);
  });

  it("keeps repeated downloads independent (edge case)", async () => {
    stubFetch(response(200));
    vi.useFakeTimers();

    void downloadFile("/api/chat/attachments/att-1");
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(30_000);
    void downloadFile("/api/chat/attachments/att-2");
    await vi.advanceTimersByTimeAsync(0);

    // The second click must not cancel the first transfer by reusing its frame.
    expect(frames().map((f) => f.getAttribute("src"))).toEqual([
      "/api/chat/attachments/att-1",
      "/api/chat/attachments/att-2",
    ]);

    vi.advanceTimersByTime(31_000);
    expect(frames().map((f) => f.getAttribute("src"))).toEqual(["/api/chat/attachments/att-2"]);
  });

  it("does nothing without a document (server render)", async () => {
    const doc = globalThis.document;
    const fetchMock = stubFetch(response(200));
    // @ts-expect-error  simulating the server render, where there is no DOM.
    delete globalThis.document;

    try {
      await expect(downloadFile("/api/chat/attachments/att-1")).resolves.toBeUndefined();
    } finally {
      globalThis.document = doc;
    }

    expect(frames()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
