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
