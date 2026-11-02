/**
 * Who may open a share link. `public` is anyone holding the token; `account` is
 * a signed-in user of this instance.
 *
 * The vocabulary lives apart from the loader so a client component can read it
 * without pulling the database in.
 */
export type ShareAccess = "public" | "account";

export const SHARE_ACCESSES = ["public", "account"] as const satisfies readonly ShareAccess[];

export const DEFAULT_SHARE_ACCESS: ShareAccess = "public";

export function isShareAccess(value: unknown): value is ShareAccess {
  return SHARE_ACCESSES.includes(value as ShareAccess);
}
