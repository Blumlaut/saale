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

/**
 * How long the frame stays in the document. Long enough for the transfer to
 * start. the browser keeps a started download alive after the frame is gone
 * and short enough that repeated clicks cannot pile up frames.
 */
const FRAME_LIFETIME_MS = 60_000;

export function downloadFile(url: string): void {
  if (typeof document === "undefined") return;

  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  frame.src = url;
  document.body.appendChild(frame);

  setTimeout(() => frame.remove(), FRAME_LIFETIME_MS);
}
