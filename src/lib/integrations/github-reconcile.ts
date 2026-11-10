/**
 * Making the stored GitHub source true.
 *
 * `github-source.ts` decides, `github-credentials.ts` knows how to write the
 * workspace, and this is the function that walks the three steps between them:
 * read what the instance allows and what the account chose, look at what is
 * actually there (the app's authorization, the CLI login in the workspace), and
 * then put the workspace in the state the decision names. The stored source is
 * written **after** that worked, never before: a state that claims "app" while
 * the workspace carries no token is the one thing this is here to prevent.
 *
 * The probes are cheap but not free (one `gh auth status` in the sandbox), so a
 * reconcile is throttled to once a minute per account. A sign-in, a sign-out and
 * a remote command each force one immediately.
 */

import { githubCliLogin } from "@/lib/coder/github";
import { ensureAdminSettings, setSetting } from "@/lib/settings/update";
import { getRedis } from "@/lib/redis";
import { readGithubAppCredentials, readGithubAppStatus } from "./github-app";
import { applyGithubSource, readStoredGithubSource } from "./github-credentials";
import {
  GITHUB_METHOD_DEFAULT,
  decideGithubSource,
  isGithubMethod,
  type GithubMethod,
  type GithubSource,
  type GithubSourceDecision,
  type GithubSourceFacts,
} from "./github-source";

/** How long a reconcile is trusted before the next read does it again. */
const RECONCILE_TTL_SECONDS = 60;

/** What a reconcile found and did. */
export interface GithubReconcileResult extends GithubSourceDecision {
  /** Why the workspace could not be brought in line, when it could not. */
  error: string | null;
}

/** The method this instance offers, tolerating a value the registry cannot hold. */
export async function readGithubMethod(): Promise<GithubMethod> {
  const admin = await ensureAdminSettings().catch((err: unknown) => {
    console.error("Failed to read the GitHub method of this instance:", err);
    return null;
  });
  const stored = admin?.githubMethod ?? GITHUB_METHOD_DEFAULT;
  return isGithubMethod(stored) ? stored : GITHUB_METHOD_DEFAULT;
}

/**
 * Put one workspace in line with what the instance allows and the account chose.
 *
 * `force` skips the minute-long throttle; the moment after a sign-in or a
 * sign-out is exactly when the answer must not be the previous one.
 */
export async function reconcileGithubSource(
  userId: string,
  options: { force?: boolean } = {},
): Promise<GithubReconcileResult> {
  if (!options.force && !(await claimReconcile(userId))) {
    const source = await readStoredGithubSource(userId);
    return { target: source, changed: false, notices: [], error: null };
  }

  const [method, source] = await Promise.all([readGithubMethod(), readStoredGithubSource(userId)]);

  // No app on the instance means the probe below would only cost a command.
  const app = await readGithubAppCredentials();
  const status = app?.enabled
    ? await readGithubAppStatus(userId).catch((err: unknown) => {
        console.error(`Failed to read the GitHub app status of ${userId}:`, err);
        return null;
      })
    : null;

  const cliLogin = await githubCliLogin(userId).catch((err: unknown) => {
    console.error(`Failed to read the GitHub CLI login of ${userId}:`, err);
    return null;
  });

  const facts: GithubSourceFacts = {
    appConfigured: Boolean(app?.enabled),
    appAuthorized: Boolean(status?.authorized),
    appInstallation: Boolean(status?.installations.some((entry) => !entry.suspended)),
    cli: cliLogin ? { login: cliLogin } : null,
  };

  const decision = decideGithubSource({ method, source, facts });

  try {
    await applyGithubSource(userId, decision.target);
  } catch (err) {
    console.error(`Failed to apply the GitHub source "${decision.target}" for ${userId}:`, err);
    return {
      ...decision,
      changed: false,
      error: err instanceof Error ? err.message : "The workspace could not be updated",
    };
  }

  if (decision.changed) {
    // The write also drops the pooled agent session, whose prompt says which
    // source is available.
    await setSetting(userId, "github.source", decision.target).catch((err: unknown) => {
      console.error(`Failed to store the GitHub source "${decision.target}" for ${userId}:`, err);
    });
  }

  return { ...decision, error: null };
}

/** True when this call may do the work; false while a recent one is trusted. */
async function claimReconcile(userId: string): Promise<boolean> {
  const key = `github-reconcile:${userId}`;
  const recent = await getRedis()
    .get(key)
    .catch((err: unknown) => {
      console.error(`Failed to read the GitHub reconcile mark of ${userId}:`, err);
      return null;
    });
  if (recent) return false;

  await getRedis()
    .set(key, "1", "EX", RECONCILE_TTL_SECONDS)
    .catch((err: unknown) => {
      console.error(`Failed to mark the GitHub reconcile of ${userId}:`, err);
    });
  return true;
}

/** The source this account is on, for a caller that only needs the value. */
export async function currentGithubSource(userId: string): Promise<GithubSource | ""> {
  return readStoredGithubSource(userId);
}
