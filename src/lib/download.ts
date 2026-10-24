/**
 * Start a download without navigating the document the user is looking at.
 *
 * A plain `<a download>` or anchor click navigates, and that is what breaks on
 * Firefox for Android: the browser opens the file in the tab it was clicked
 * from. or hands it to the download manager and leaves the tab behind
 * ending on `about:blank`, with the app gone (bugzilla 1919827 and 1953287,
 * both open). An installed web app and a home-screen shortcut are exactly the
 * contexts that hit it, because they get a custom tab with no way back.
 *
 * Pointing a hidden frame at the URL keeps the navigation in a nested context
 * the user never sees, so the app survives whatever the browser does with the
 * download itself. The response's `Content-Disposition` still names the file;
 * framing does not stand in the way, because the download is decided before
 * `X-Frame-Options`/`frame-ancestors` are enforced.
 */

import { toast } from "sonner";

/**
 * How long the frame stays in the document. Long enough for the transfer to
 * start. the browser keeps a started download alive after the frame is gone
 * and short enough that repeated clicks cannot pile up frames.
 */
const FRAME_LIFETIME_MS = 60_000;

/** Why a click produced no file. */
type Refusal = "missing" | "failed";

/**
 * Ask the server for the status before a frame is aimed at the URL.
 *
 * The frame is a navigation nobody can see, so a file that is gone, a path that
 * moved after it was shared into a chat, or an expired session all ended as a
 * button that did nothing at all: indistinguishable from a download that
 * worked. Checking first costs the response headers, not the bytes. the body is
 * cancelled as soon as the status is in.
 */
async function refusal(url: string): Promise<Refusal | null> {
  try {
    const response = await fetch(url, { credentials: "include" });
    await response.body?.cancel();
    if (response.ok) return null;
    console.error(`Download refused (${response.status}): ${url}`);
    return response.status === 404 ? "missing" : "failed";
  } catch (err) {
    console.error(`Failed to check the download at ${url}:`, err);
    return "failed";
  }
}

export async function downloadFile(url: string): Promise<void> {
  if (typeof document === "undefined") return;

  const blocked = await refusal(url);
  if (blocked) {
    toast.error(
      blocked === "missing"
        ? "That file is no longer in the workspace"
        : "Could not download that file",
    );
    return;
  }

  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  frame.src = url;
  document.body.appendChild(frame);

  setTimeout(() => frame.remove(), FRAME_LIFETIME_MS);
}
