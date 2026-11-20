/**
 * The endpoints the client downloads by aiming a hidden frame at them.
 *
 * WebKit applies `X-Frame-Options` and `frame-ancestors` before it decides a
 * response is a download, so `DENY`/`'none'` on one of these is a button that
 * quietly does nothing in Safari. `@/middleware` lets this origin frame them and
 * nothing frame the rest.
 *
 * A route that starts sending downloads has to be added here:
 * `__tests__/pwa/middleware-headers.test.ts` reads the routes and fails.
 */
export const DOWNLOAD_PREFIXES = [
  "/api/files/raw",
  "/api/files/zip",
  "/api/chat/attachments/",
  "/api/chat/workspace-files",
  "/api/calendar/export",
];
