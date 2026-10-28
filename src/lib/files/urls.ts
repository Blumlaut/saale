/**
 * URLs for the file endpoints. The raw endpoint is keyed by target and path;
 * the target is a workspace handle the request layer resolves, never a file
 * system path the client invents.
 */

/** Raw bytes of one file, inline or as a download. */
export function rawFileUrl(target: string, path: string, download = false): string {
  const query = new URLSearchParams({ target, path });
  if (download) query.set("download", "1");
  return `/api/files/raw?${query.toString()}`;
}

/** The endpoint that writes one file's text; the path travels in the body. */
export function writeFileUrl(target: string): string {
  return `/api/files/write?${new URLSearchParams({ target }).toString()}`;
}
