/**
 * What the Next server does before it answers anything.
 *
 * The workspaces volume still holds directories named by the old
 * `user-<userId>` scheme on a deployment that predates the short keys. They are
 * moved here, not by an operator: a request served first would create the new
 * directory beside the old one and split a user's files. `register` is the one
 * hook that completes before the server is ready to handle requests.
 *
 * The worker and the sandbox service do the same thing on their own startup;
 * the migration is idempotent and safe to run concurrently.
 */

export async function register(): Promise<void> {
  // Only the node runtime has the volume mounted.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { migrateWorkspaceIdentitiesOnBoot } = await import("@/lib/sandbox/legacy-identities");
  await migrateWorkspaceIdentitiesOnBoot("web");
}
