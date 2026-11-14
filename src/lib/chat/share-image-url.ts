/**
 * Where a shared chat's rendered picture is served from.
 *
 * The picture is not embedded in the share payload: it is fetched through the
 * chat's own token, by the id of the call that rendered it, so unsharing takes
 * it away and the payload never names a workspace path.
 */
export function shareImageUrl(token: string, callId: string): string {
  return `/api/chat/sessions/share/${encodeURIComponent(token)}/images/${encodeURIComponent(callId)}`;
}
