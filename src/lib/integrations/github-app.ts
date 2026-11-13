/**
 * The state behind the GitHub App: what an admin saved, who authorized it, and
 * which tokens the workspace may use.
 *
 * `github-app-client.ts` is the requests; this is the bookkeeping around them.
 *
 * - **The app's own credential** is instance infrastructure, one row, encrypted
 *   at rest (the settings tables carry no secrets, which is why it is a model of
 *   its own). It exists only once an admin saved a set GitHub accepted: the
 *   save path reads `GET /app` with it, so a wrong app id or key is refused at
 *   the form instead of failing later inside a chat.
 * - **A user's authorization** (the `ghu_`/`ghr_` pair) is refreshed on use, so
 *   the eight-hour access token never expires under a command. A refresh that
 *   GitHub refuses deletes the row: the card then says "connect again" rather
 *   than showing a connection that cannot do anything.
 * - **Installations** are synced from the user's own token, so a row is a fact
 *   about GitHub rather than something Saale assumed. Two Saale accounts that
 *   can reach the same organization share the installation and each has their
 *   own access row.
 * - **Installation tokens** are minted per use and cached in Redis until shortly
 *   before they expire. Narrowing happens here: the caller names the repository
 *   and permissions, and the token cannot exceed what the installation grants.
 *
 * Nothing in this module is wired into a request, a tool or a job yet — the
 * applier that switches a workspace between the two sources comes next.
 */

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { decrypt, encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { appCanManageInstallations } from "./github";
import {
  GithubApiError,
  createAppJwt,
  createInstallationToken,
  addInstallationRepository,
  listInstallationRepositories,
  listInstallationRepositoryRefs,
  listInstallations,
  listRepositoryChoices,
  removeInstallationRepository,
  pollDeviceCode,
  readAppIdentity,
  readUserLogin,
  refreshUserTokens,
  requestDeviceCode,
  type GithubAppCredentials,
  type GithubDeviceCode,
  type GithubInstallationSummary,
  type GithubTokenScope,
  type GithubUserTokens,
} from "./github-app-client";

/** The single row that holds this instance's app. */
const GITHUB_APP_ID = "global";

/** A sign-in may wait this long for the user; GitHub expires the code at 15 minutes. */
const LOGIN_TTL_SECONDS = 15 * 60;

/** A refresh token is only usable for six months, so a flow never outlives it. */
const REFRESH_SKEW_MS = 5 * 60_000;

/** Installation tokens last an hour; a cached one is dropped a minute early. */
const TOKEN_CACHE_SKEW_MS = 60_000;

/** A poll is not repeated more often than the interval GitHub asked for. */
const POLL_FLOOR_MS = 1_000;

/**
 * Repository lists read in one sync.
 *
 * One request each, so a big account is not walked end to end on a card read.
 * A list that is not read keeps the value it had: GitHub is the authority on a
 * mint either way, and a stale entry only makes the picker show an old set.
 */
const MAX_REPOSITORY_SYNCS = 50;

/**
 * How long a read trusts the stored installations.
 *
 * The card asks for the status while a sign-in runs and whenever the tab is
 * looked at, so a sync per read would mean two GitHub calls per installation
 * every few seconds. A minute is short enough that an installation made in a
 * browser shows up on its own.
 */
const INSTALLATION_SYNC_TTL_SECONDS = 60;

/** An admin's complete credential set, before it is verified. */
export interface GithubAppInput {
  appId: string;
  clientId: string;
  clientSecret: string;
  /** PEM private key, downloaded from the app's settings page. */
  privateKey: string;
  adminUserId: string;
}

/** The app as the admin surface may read it: no secrets, ever. */
export interface GithubAppSummary {
  appId: string;
  clientId: string;
  slug: string;
  name: string;
  ownerLogin: string;
  permissions: Record<string, string> | null;
  enabled: boolean;
  updatedAt: Date;
}

/** A sign-in the card shows a code for. */
export interface GithubDeviceLogin {
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
}

/** What one poll of a sign-in opened. */
export type GithubLoginPoll =
  | { state: "idle" }
  | { state: "pending"; login: GithubDeviceLogin }
  | { state: "slow-down"; login: GithubDeviceLogin }
  | { state: "expired" }
  | { state: "denied" }
  | { state: "authorized"; login: string };

/** A stored user token, ready to send. */
export interface GithubUserAccess {
  accessToken: string;
  login: string;
  /** Null when GitHub issued a token without an expiry. */
  expiresAt: Date | null;
}

/** One installation the account may use, as the card lists it. */
export interface GithubInstallationView {
  installationId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  /** Repositories it covers; null when it was granted every repository. */
  repositories: string[] | null;
  suspended: boolean;
}

/**
 * An installation plus the row id a token mint takes.
 *
 * The id is the internal one on purpose: GitHub's installation number is a
 * guessable integer, and the access check is what has to gate a mint.
 */
export interface GithubInstallationTarget extends GithubInstallationView {
  rowId: string;
}

/** The whole connection, as the card renders it. */
export interface GithubAppStatus {
  /** An admin saved a credential set and left it switched on. */
  configured: boolean;
  /** The app's slug, for the install link GitHub hosts. */
  slug: string | null;
  /** The app's display name. */
  name: string | null;
  /** The permissions the app was registered with. */
  permissions: Record<string, string> | null;
  /** The account authorized the app. */
  authorized: { login: string; expiresAt: Date | null } | null;
  installations: GithubInstallationView[];
}

/** A sign-in in flight, in Redis so a restart does not lose the code. */
interface StoredLogin extends GithubDeviceLogin {
  userId: string;
  deviceCode: string;
  intervalSeconds: number;
  /** When the next poll is allowed. */
  nextPollAt: string;
}

/** The app cannot be used: not saved, switched off, or GitHub refused it. */
export class GithubAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubAppError";
  }
}

// ─── The app credential ─────────────────────────────────────────────────────

/** The saved credential set, decrypted, or null when none is saved. */
export async function readGithubAppCredentials(): Promise<
  (GithubAppCredentials & { enabled: boolean; slug: string }) | null
> {
  const row = await prisma.githubApp
    .findUnique({ where: { id: GITHUB_APP_ID } })
    .catch((err: unknown) => {
      console.error("Failed to read the GitHub App credentials:", err);
      return null;
    });
  if (!row) return null;

  try {
    return {
      appId: row.appId,
      clientId: row.clientId,
      clientSecret: decrypt(row.encryptedClientSecret),
      privateKey: decrypt(row.encryptedPrivateKey),
      enabled: row.enabled,
      slug: row.slug,
    };
  } catch (err) {
    console.error("Failed to decrypt the GitHub App credentials:", err);
    return null;
  }
}

/** The saved app as the admin surface shows it: metadata only. */
export async function readGithubAppSummary(): Promise<GithubAppSummary | null> {
  const row = await prisma.githubApp
    .findUnique({ where: { id: GITHUB_APP_ID } })
    .catch((err: unknown) => {
      console.error("Failed to read the GitHub App row:", err);
      return null;
    });
  if (!row) return null;

  return {
    appId: row.appId,
    clientId: row.clientId,
    slug: row.slug,
    name: row.name,
    ownerLogin: row.ownerLogin,
    permissions: isStringRecord(row.permissions) ? row.permissions : null,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
  };
}

/**
 * Save the credential set, after GitHub agreed it is the app it claims to be.
 *
 * Verifying here is the whole point of the form: an app id that does not match
 * the key, or a key GitHub cannot read, is refused now — not on the first push
 * of a chat that trusted the card.
 */
export async function saveGithubApp(input: GithubAppInput): Promise<GithubAppSummary> {
  const appId = input.appId.trim();
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  const privateKey = input.privateKey.trim();

  if (!/^\d+$/.test(appId)) throw new GithubAppError("The app id is a number.");
  if (!clientId) throw new GithubAppError("The client id is required.");
  if (!clientSecret) throw new GithubAppError("The client secret is required.");
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    throw new GithubAppError("The private key has to be the PEM file GitHub gave you.");
  }

  let identity: Awaited<ReturnType<typeof readAppIdentity>>;
  try {
    const jwt = await createAppJwt({ appId, privateKey });
    identity = await readAppIdentity(jwt);
  } catch (err) {
    console.error("GitHub did not accept the app credentials an admin saved:", err);
    if (err instanceof GithubApiError) {
      // A key this build cannot read is the admin's file, not GitHub refusing
      // it: say which of the two it is, so the form can be fixed on the spot.
      const unreadable = err.status === 0 && /private key/i.test(err.message);
      throw new GithubAppError(
        unreadable
          ? "The private key could not be read. Paste the complete .pem file GitHub generated, including the BEGIN and END lines."
          : `GitHub refused these credentials: ${err.message}. Check the app id and the private key.`,
      );
    }
    throw err;
  }

  // A JSON column takes a value or a database null, never `undefined`
  // (`exactOptionalPropertyTypes`), so an absent permissions map is left out.
  const permissions = identity.permissions
    ? { permissions: identity.permissions as Prisma.InputJsonValue }
    : {};

  const row = await prisma.githubApp.upsert({
    where: { id: GITHUB_APP_ID },
    create: {
      id: GITHUB_APP_ID,
      appId,
      clientId,
      encryptedClientSecret: encrypt(clientSecret),
      encryptedPrivateKey: encrypt(privateKey),
      slug: identity.slug,
      name: identity.name,
      ownerLogin: identity.ownerLogin,
      ...permissions,
      enabled: true,
      updatedByUserId: input.adminUserId,
    },
    update: {
      appId,
      clientId,
      encryptedClientSecret: encrypt(clientSecret),
      encryptedPrivateKey: encrypt(privateKey),
      slug: identity.slug,
      name: identity.name,
      ownerLogin: identity.ownerLogin,
      ...permissions,
      enabled: true,
      updatedByUserId: input.adminUserId,
    },
  });

  return {
    appId: row.appId,
    clientId: row.clientId,
    slug: row.slug,
    name: row.name,
    ownerLogin: row.ownerLogin,
    permissions: isStringRecord(row.permissions) ? row.permissions : null,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
  };
}

/** The admin's switch. Off keeps the credentials for a switch back. */
export async function setGithubAppEnabled(enabled: boolean): Promise<void> {
  await prisma.githubApp.updateMany({ where: { id: GITHUB_APP_ID }, data: { enabled } });
}

/**
 * Forget the app entirely.
 *
 * Installations and their access rows go with it, and so does every stored user
 * token: a token that outlived its app is a credential nobody can revoke from
 * inside Saale. The authorization itself stays at GitHub, where the user removes
 * it under "Authorized GitHub Apps".
 */
export async function deleteGithubApp(): Promise<void> {
  await prisma.githubUserToken.deleteMany({});
  await prisma.githubInstallationAccess.deleteMany({});
  await prisma.githubInstallation.deleteMany({});
  await prisma.githubApp.deleteMany({ where: { id: GITHUB_APP_ID } });
}

/** The credential set, or the reason there is nothing to do. */
async function requireGithubApp(): Promise<GithubAppCredentials & { slug: string }> {
  const app = await readGithubAppCredentials();
  if (!app) {
    throw new GithubAppError(
      "This instance has no GitHub App. An admin has to add one before GitHub can be connected.",
    );
  }
  if (!app.enabled) {
    throw new GithubAppError("The GitHub App is switched off on this instance.");
  }
  return app;
}

// ─── Signing in ─────────────────────────────────────────────────────────────

/**
 * Open a sign-in and hand back the code the user types in a browser.
 *
 * The code lives in Redis, not in memory: a restarted server keeps the sign-in
 * the user is looking at, and a poll is only made when the interval GitHub named
 * has passed, so a card that asks every few seconds does not walk into
 * `slow_down`.
 */
export async function startGithubAppLogin(userId: string): Promise<GithubDeviceLogin> {
  const app = await requireGithubApp();
  const code: GithubDeviceCode = await requestDeviceCode(app.clientId);

  const login: StoredLogin = {
    userId,
    deviceCode: code.deviceCode,
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    expiresAt: new Date(Date.now() + code.expiresInSeconds * 1000),
    intervalSeconds: code.intervalSeconds,
    nextPollAt: new Date(Date.now() + code.intervalSeconds * 1000).toISOString(),
  };

  await getRedis().set(loginKey(userId), JSON.stringify(login), "EX", LOGIN_TTL_SECONDS);
  return toDeviceLogin(login);
}

/**
 * One step of a sign-in, driven by whatever asks for the status.
 *
 * Returns `idle` when nothing is in flight, so a card that polls forever stays
 * quiet instead of erroring. A successful poll stores the token, syncs the
 * installations and forgets the code.
 */
export async function pollGithubAppLogin(userId: string): Promise<GithubLoginPoll> {
  const login = await readStoredLogin(userId);
  if (!login) return { state: "idle" };

  if (login.expiresAt.getTime() <= Date.now()) {
    await forgetGithubAppLogin(userId);
    return { state: "expired" };
  }

  if (new Date(login.nextPollAt).getTime() > Date.now()) {
    return { state: "pending", login: toDeviceLogin(login) };
  }

  const app = await requireGithubApp();
  const answer = await pollDeviceCode(app.clientId, login.deviceCode);

  switch (answer.state) {
    case "pending":
    case "slow-down": {
      // A slow_down adds the five seconds GitHub asks for, on top of the interval.
      const wait = login.intervalSeconds + (answer.state === "slow-down" ? 5 : 0);
      const next: StoredLogin = {
        ...login,
        nextPollAt: new Date(Date.now() + Math.max(wait * 1000, POLL_FLOOR_MS)).toISOString(),
      };
      await writeStoredLogin(userId, next);
      return { state: answer.state, login: toDeviceLogin(next) };
    }
    case "expired":
    case "denied":
      await forgetGithubAppLogin(userId);
      return { state: answer.state };
    case "authorized": {
      const tokens = answer.tokens;
      const stored = await storeUserTokens(userId, tokens);
      await forgetGithubAppLogin(userId);
      await syncGithubInstallations(userId, stored.access.accessToken).catch((err: unknown) => {
        console.error(`Failed to sync the GitHub installations of ${userId}:`, err);
      });
      return { state: "authorized", login: stored.login };
    }
  }
}

/** Drop a sign-in in flight; the code stops being polled. */
export async function forgetGithubAppLogin(userId: string): Promise<void> {
  await getRedis()
    .del(loginKey(userId))
    .catch((err: unknown) => {
      console.error(`Failed to forget the GitHub sign-in of ${userId}:`, err);
    });
}

/**
 * Sign out: forget the token and the installations this account could reach.
 *
 * The app stays authorized at GitHub — Saale has no way to withdraw that, and
 * pretending otherwise would be worse than saying where to do it.
 */
export async function signOutGithubApp(userId: string): Promise<void> {
  await forgetGithubAppLogin(userId);
  await prisma.githubUserToken.deleteMany({ where: { userId } });
  await prisma.githubInstallationAccess.deleteMany({ where: { userId } });
}

// ─── The user's token ───────────────────────────────────────────────────────

/**
 * The user's access token, refreshed when it is about to expire.
 *
 * A refresh GitHub refuses removes the row and returns null: an expired
 * authorization is a state the card can explain, while a token that fails every
 * command is not.
 */
export async function readGithubUserAccess(userId: string): Promise<GithubUserAccess | null> {
  const row = await prisma.githubUserToken
    .findUnique({ where: { userId } })
    .catch((err: unknown) => {
      console.error(`Failed to read the GitHub token of ${userId}:`, err);
      return null;
    });
  if (!row) return null;

  if (row.accessExpiresAt.getTime() - REFRESH_SKEW_MS > Date.now()) {
    try {
      return {
        accessToken: decrypt(row.encryptedAccessToken),
        login: row.login,
        expiresAt: row.accessExpiresAt,
      };
    } catch (err) {
      console.error(`Failed to decrypt the GitHub token of ${userId}:`, err);
      return null;
    }
  }

  if (row.refreshExpiresAt.getTime() <= Date.now()) {
    await prisma.githubUserToken.deleteMany({ where: { userId } });
    return null;
  }

  const app = await readGithubAppCredentials();
  if (!app) {
    console.error(`The GitHub App is gone, so ${userId} cannot refresh its token.`);
    return null;
  }

  try {
    const tokens = await refreshUserTokens({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken: decrypt(row.encryptedRefreshToken),
    });
    return (await storeUserTokens(userId, tokens, row.login)).access;
  } catch (err) {
    console.error(`GitHub refused to refresh the token of ${userId}:`, err);
    await prisma.githubUserToken.deleteMany({ where: { userId } });
    return null;
  }
}

/** Store a fresh pair for a user, keeping the login it belongs to. */
async function storeUserTokens(
  userId: string,
  tokens: GithubUserTokens,
  knownLogin?: string,
): Promise<{ access: GithubUserAccess; login: string }> {
  const login = knownLogin ?? (await readUserLogin(tokens.accessToken));

  // Without `expires_in` GitHub means a token with no expiry; the far future is
  // what "never" looks like in this row, and no refresh is attempted for it.
  const accessExpiresAt = tokens.accessExpiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60_000);
  const refreshExpiresAt = tokens.refreshExpiresAt ?? accessExpiresAt;

  await prisma.githubUserToken.upsert({
    where: { userId },
    create: {
      userId,
      encryptedAccessToken: encrypt(tokens.accessToken),
      encryptedRefreshToken: encrypt(tokens.refreshToken ?? ""),
      accessExpiresAt,
      refreshExpiresAt,
      login,
    },
    update: {
      encryptedAccessToken: encrypt(tokens.accessToken),
      encryptedRefreshToken: encrypt(tokens.refreshToken ?? ""),
      accessExpiresAt,
      refreshExpiresAt,
      login,
    },
  });

  return {
    access: { accessToken: tokens.accessToken, login, expiresAt: tokens.accessExpiresAt },
    login,
  };
}

// ─── Installations ──────────────────────────────────────────────────────────

/**
 * Bring the stored installations in line with what GitHub says this user reaches.
 *
 * Rows are upserted by GitHub's installation id, the access row is stamped, and
 * an installation the user can no longer reach loses its access row — the
 * installation itself stays, because another account may still use it.
 */
export async function syncGithubInstallations(
  userId: string,
  accessToken?: string,
): Promise<GithubInstallationView[]> {
  const access = accessToken
    ? { accessToken, login: "", expiresAt: null }
    : await readGithubUserAccess(userId);
  if (!access) return [];

  const summaries = await listInstallations(access.accessToken).catch((err: unknown) => {
    console.error(`Failed to list the GitHub installations of ${userId}:`, err);
    return null;
  });
  if (!summaries) return [];

  const seen: string[] = [];
  let repositoryReads = 0;
  for (const summary of summaries) {
    const repositories =
      summary.repositorySelection === "selected" && repositoryReads < MAX_REPOSITORY_SYNCS
        ? await listInstallationRepositories(access.accessToken, summary.installationId).catch(
            (err: unknown) => {
              console.error(
                `Failed to list the repositories of installation ${summary.installationId}:`,
                err,
              );
              return null;
            },
          )
        : null;
    if (repositories) repositoryReads += 1;

    const installation = await prisma.githubInstallation.upsert({
      where: { installationId: summary.installationId },
      create: {
        installationId: summary.installationId,
        accountLogin: summary.accountLogin,
        accountType: summary.accountType,
        repositorySelection: summary.repositorySelection,
        ...(repositories ? { repositories } : {}),
        ...(summary.permissions ? { permissions: summary.permissions } : {}),
        suspendedAt: summary.suspended ? new Date() : null,
      },
      update: {
        accountLogin: summary.accountLogin,
        accountType: summary.accountType,
        repositorySelection: summary.repositorySelection,
        ...(repositories ? { repositories } : {}),
        ...(summary.permissions ? { permissions: summary.permissions } : {}),
        suspendedAt: summary.suspended ? new Date() : null,
      },
    });

    await prisma.githubInstallationAccess.upsert({
      where: { userId_installationId: { userId, installationId: installation.id } },
      create: { userId, installationId: installation.id, lastSeenAt: new Date() },
      update: { lastSeenAt: new Date() },
    });
    seen.push(installation.id);
  }

  await prisma.githubInstallationAccess.deleteMany({
    where: { userId, installationId: { notIn: seen } },
  });

  return readGithubInstallations(userId);
}

/**
 * The installations, re-read from GitHub when the stored ones are a minute old.
 *
 * This is what makes an installation that happened outside Saale — the browser
 * tab where the app was installed on an organization — appear on its own.
 */
export async function refreshGithubInstallations(
  userId: string,
): Promise<GithubInstallationView[]> {
  const key = `github-install-sync:${userId}`;
  const fresh = await getRedis()
    .get(key)
    .catch((err: unknown) => {
      console.error(`Failed to read the GitHub installation sync mark of ${userId}:`, err);
      return null;
    });

  if (fresh) return readGithubInstallations(userId);

  await getRedis()
    .set(key, "1", "EX", INSTALLATION_SYNC_TTL_SECONDS)
    .catch((err: unknown) => {
      console.error(`Failed to mark the GitHub installation sync of ${userId}:`, err);
    });

  return syncGithubInstallations(userId);
}

/**
 * An installation row as it comes out of Postgres.
 *
 * `id` is Saale's own row id, which a mint takes instead of GitHub's guessable
 * installation number; `installationView` deliberately does not forward it.
 */
type GithubInstallationRow = {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  repositories: unknown;
  suspendedAt: Date | null;
};

/** What one stored installation says, whether the card or a mint reads it. */
function installationView(row: GithubInstallationRow): GithubInstallationView {
  return {
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    repositorySelection: row.repositorySelection,
    repositories: isStringArray(row.repositories) ? row.repositories : null,
    suspended: row.suspendedAt !== null,
  };
}

/** The installations this account may use, as the card lists them. */
export async function readGithubInstallations(userId: string): Promise<GithubInstallationView[]> {
  const rows = await prisma.githubInstallationAccess
    .findMany({ where: { userId }, include: { installation: true } })
    .catch((err: unknown) => {
      console.error(`Failed to read the GitHub installations of ${userId}:`, err);
      return [];
    });

  return rows
    .map((row) => installationView(row.installation))
    .sort((a, b) => a.accountLogin.localeCompare(b.accountLogin));
}

/**
 * The installation that owns a repository owner, if this account may use it.
 *
 * GitHub logins are case-insensitive, so the comparison is too. A suspended
 * installation is not usable and reads as absent.
 */
export async function githubInstallationForOwner(
  userId: string,
  owner: string,
): Promise<GithubInstallationTarget | null> {
  const wanted = owner.trim().toLowerCase();
  if (!wanted) return null;

  const access = await prisma.githubInstallationAccess
    .findFirst({
      where: {
        userId,
        installation: {
          accountLogin: { equals: wanted, mode: "insensitive" },
          suspendedAt: null,
        },
      },
      include: { installation: true },
    })
    .catch((err: unknown) => {
      console.error(`Failed to find the GitHub installation for ${wanted} of ${userId}:`, err);
      return null;
    });
  if (!access) return null;

  return { rowId: access.installation.id, ...installationView(access.installation) };
}

// ─── Which repositories an installation may use ─────────────────────────────

/** One installation's repository set, as the picker shows it. */
export interface GithubRepositoryChoices {
  /** GitHub's installation id. */
  installationId: string;
  accountLogin: string;
  /** "User" | "Organization" — decides where GitHub's settings page lives. */
  accountType: string;
  /** "all" or "selected". */
  selection: string;
  /**
   * Whether Saale can change the set. GitHub only removes repositories from an
   * installation that was granted "Only select repositories"; an "All
   * repositories" installation has to be switched on GitHub first.
   */
  canManage: boolean;
  /**
   * Whether the app itself may change the set.
   *
   * The picker's two calls take `installation_repositories: write`, so an app
   * registered without that permission can show what an installation covers and
   * nothing more. The card offers the save only when both this and `canManage`
   * hold, and `applyGithubRepositoryChoices` says which one is missing.
   */
  appCanManage: boolean;
  /** Repositories the installation covers. */
  installed: { id: string; name: string; fullName: string }[];
  /** Repositories this account could add, with the installed ones marked. */
  candidates: { id: string; fullName: string; installed: boolean }[];
}

/**
 * The access row for one installation of one account, or a refusal.
 *
 * The id is GitHub's — the number the card shows, the API paths take and the
 * picker sends back — not Saale's own row id. The access row is what says
 * whether this account may act on that installation at all.
 */
async function requireInstallationAccess(userId: string, installationId: string) {
  const row = await prisma.githubInstallationAccess.findFirst({
    where: { userId, installation: { installationId } },
    include: { installation: true },
  });
  if (!row) throw new GithubAppError("This account has no access to that GitHub installation.");
  if (row.installation.suspendedAt)
    throw new GithubAppError("That GitHub installation is suspended.");
  return row.installation;
}

/**
 * The app's permissions as GitHub has them now, written back when they moved.
 *
 * The stored copy is only as fresh as the last save in the admin panel, and a
 * permission added on GitHub is exactly the change that happens without Saale
 * knowing: the card would keep saying the picker cannot work, or offer a save
 * GitHub refuses. One `GET /app` beside a picker read is cheaper than being
 * wrong, and a read GitHub refuses leaves the stored set alone.
 */
async function refreshGithubAppPermissions(): Promise<Record<string, string> | null> {
  const stored = await readGithubAppSummary();
  if (!stored) return null;
  const credentials = await readGithubAppCredentials();
  if (!credentials) return stored.permissions;

  try {
    const jwt = await createAppJwt({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
    });
    const identity = await readAppIdentity(jwt);
    const fresh = identity.permissions ?? null;
    if (JSON.stringify(fresh) !== JSON.stringify(stored.permissions)) {
      await prisma.githubApp.update({
        where: { id: GITHUB_APP_ID },
        data: fresh ? { permissions: fresh as Prisma.InputJsonValue } : {},
      });
    }
    return fresh;
  } catch (err) {
    console.error("Failed to re-read the GitHub App's permissions:", err);
    return stored.permissions;
  }
}

/** What to tell an admin whose app may not change its own installations. */
const APP_CANNOT_MANAGE_INSTALLATIONS =
  "The app may not change its own installations: it was registered without the “GitHub App installation repository access” permission (installation_repositories: write). Add the permission to the app on GitHub — every installation then approves it once — or change the repositories on GitHub's page.";

/**
 * GitHub answers those two calls with a 403 when the app lacks the permission,
 * and its body ("Resource not accessible by integration") names nothing an
 * admin could act on. Any other refusal is passed on as it is.
 */
function installationRepositoryRefusal(err: unknown): unknown {
  if (err instanceof GithubApiError && err.status === 403) {
    return new GithubAppError(APP_CANNOT_MANAGE_INSTALLATIONS);
  }
  return err;
}

/**
 * What one installation covers, and what could be added to it.
 *
 * Both reads use the account's own token, so GitHub answers with what *this*
 * person may do — the picker never offers a repository the user cannot install
 * the app on.
 */
export async function readGithubRepositoryChoices(
  userId: string,
  installationId: string,
): Promise<GithubRepositoryChoices> {
  const [installation, appPermissions] = await Promise.all([
    requireInstallationAccess(userId, installationId),
    refreshGithubAppPermissions(),
  ]);
  const access = await readGithubUserAccess(userId);
  if (!access) throw new GithubAppError("Connect GitHub again: the authorization has expired.");

  const [installed, all] = await Promise.all([
    listInstallationRepositoryRefs(access.accessToken, installation.installationId),
    listRepositoryChoices(access.accessToken),
  ]);

  const owner = installation.accountLogin.toLowerCase();
  const installedIds = new Set(installed.map((entry) => entry.id));
  const candidates = all
    .filter((entry) => entry.canAdmin && entry.owner.toLowerCase() === owner)
    .map((entry) => ({
      id: entry.id,
      fullName: entry.fullName,
      installed: installedIds.has(entry.id),
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  return {
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    selection: installation.repositorySelection,
    canManage: installation.repositorySelection === "selected",
    appCanManage: appCanManageInstallations(appPermissions),
    installed,
    candidates,
  };
}

/**
 * Set which repositories the installation covers.
 *
 * Only the difference is sent, one call per repository, because GitHub's
 * endpoint moves exactly one. The stored repository list and the sync mark are
 * refreshed afterwards, so the card and the next mint see the new set.
 *
 * A token already minted for a repository that was just removed keeps working
 * until it expires (an hour at most) — GitHub does not revoke installation
 * tokens when an installation shrinks.
 */
export async function applyGithubRepositoryChoices(
  userId: string,
  installationId: string,
  repositoryIds: readonly string[],
): Promise<GithubRepositoryChoices> {
  const installation = await requireInstallationAccess(userId, installationId);
  if (installation.repositorySelection !== "selected") {
    throw new GithubAppError(
      "This installation covers all repositories. Switch it to “Only select repositories” on GitHub first, then choose here.",
    );
  }
  // The permission is checked here as well as in the card: a request that skips
  // the card gets the sentence that names the fix, not GitHub's 403 body.
  if (!appCanManageInstallations((await refreshGithubAppPermissions()) ?? null)) {
    throw new GithubAppError(APP_CANNOT_MANAGE_INSTALLATIONS);
  }

  const access = await readGithubUserAccess(userId);
  if (!access) throw new GithubAppError("Connect GitHub again: the authorization has expired.");

  const installed = await listInstallationRepositoryRefs(
    access.accessToken,
    installation.installationId,
  );
  const wanted = new Set(repositoryIds);
  const installedIds = new Set(installed.map((entry) => entry.id));

  const add = [...wanted].filter((id) => !installedIds.has(id));
  const remove = [...installedIds].filter((id) => !wanted.has(id));

  try {
    for (const id of add) {
      await addInstallationRepository(access.accessToken, installation.installationId, id);
    }
    for (const id of remove) {
      await removeInstallationRepository(access.accessToken, installation.installationId, id);
    }
  } catch (err) {
    throw installationRepositoryRefusal(err);
  }

  // Keep the stored row honest: the card lists it without asking GitHub again.
  const after = await listInstallationRepositoryRefs(
    access.accessToken,
    installation.installationId,
  );
  await prisma.githubInstallation.update({
    where: { id: installation.id },
    data: { repositories: after.map((entry) => entry.name) },
  });
  await forgetGithubInstallationSync(userId);

  return readGithubRepositoryChoices(userId, installationId);
}

// ─── Minting ────────────────────────────────────────────────────────────────

/**
 * An installation token for one repository (or the whole installation).
 *
 * Only an account with an access row may mint: the check is here rather than in
 * the caller, because an installation id is a guessable number. The token is
 * cached in Redis until a minute before it expires, keyed by installation and by
 * the scope, so two chats on different repositories do not share one.
 */
export async function mintGithubInstallationToken(options: {
  userId: string;
  installationId: string;
  scope?: GithubTokenScope;
}): Promise<{ token: string; expiresAt: Date }> {
  const access = await prisma.githubInstallationAccess.findUnique({
    where: {
      userId_installationId: { userId: options.userId, installationId: options.installationId },
    },
    include: { installation: true },
  });
  if (!access) {
    throw new GithubAppError("This account has no access to that GitHub installation.");
  }
  if (access.installation.suspendedAt) {
    throw new GithubAppError("That GitHub installation is suspended.");
  }

  const key = tokenCacheKey(options.installationId, options.scope);
  const cached = await getRedis()
    .get(key)
    .catch((err: unknown) => {
      console.error("Failed to read a cached GitHub installation token:", err);
      return null;
    });
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { token: string; expiresAt: string };
      return { token: parsed.token, expiresAt: new Date(parsed.expiresAt) };
    } catch (err) {
      console.error("Failed to read a cached GitHub installation token, minting a new one:", err);
    }
  }

  const app = await requireGithubApp();
  const jwt = await createAppJwt(app);
  const minted = await createInstallationToken({
    jwt,
    installationId: access.installation.installationId,
    ...(options.scope ? { scope: options.scope } : {}),
  });

  const ttlSeconds = Math.max(
    60,
    Math.round((minted.expiresAt.getTime() - Date.now() - TOKEN_CACHE_SKEW_MS) / 1000),
  );
  await getRedis()
    .set(
      key,
      JSON.stringify({ token: minted.token, expiresAt: minted.expiresAt.toISOString() }),
      "EX",
      ttlSeconds,
    )
    .catch((err: unknown) => {
      console.error("Failed to cache a GitHub installation token:", err);
    });

  return minted;
}

/** Everything the connection card needs, in one read. */
export async function readGithubAppStatus(userId: string): Promise<GithubAppStatus> {
  const app = await readGithubAppSummary();
  const token = await prisma.githubUserToken
    .findUnique({ where: { userId }, select: { login: true, accessExpiresAt: true } })
    .catch((err: unknown) => {
      console.error(`Failed to read the GitHub token of ${userId}:`, err);
      return null;
    });

  return {
    configured: Boolean(app?.enabled),
    slug: app?.slug ?? null,
    name: app?.name ?? null,
    permissions: app?.permissions ?? null,
    authorized: token ? { login: token.login, expiresAt: token.accessExpiresAt } : null,
    installations: token ? await readGithubInstallations(userId) : [],
  };
}

/**
 * Forget the sync mark, so the next status read asks GitHub again.
 *
 * GitHub's install flow returns the browser to the app's setup URL, and this is
 * what that redirect calls: the installation just happened, so a card that
 * waited out the minute would look broken for no reason.
 */
export async function forgetGithubInstallationSync(userId: string): Promise<void> {
  await getRedis()
    .del(`github-install-sync:${userId}`)
    .catch((err: unknown) => {
      console.error(`Failed to clear the GitHub installation sync mark of ${userId}:`, err);
    });
}

// ─── Redis keys and helpers ─────────────────────────────────────────────────

function loginKey(userId: string): string {
  return `github-app-login:${userId}`;
}

/**
 * One cache entry per installation and scope.
 *
 * The scope is hashed so the key stays short and no repository name sits in
 * Redis in the clear.
 */
function tokenCacheKey(installationId: string, scope: GithubTokenScope | undefined): string {
  const shape = scope
    ? createHash("sha256")
        .update(
          JSON.stringify({
            repositories: [...(scope.repositories ?? [])].sort(),
            permissions: Object.entries(scope.permissions ?? {}).sort(),
          }),
        )
        .digest("hex")
        .slice(0, 16)
    : "all";
  return `github-app-token:${installationId}:${shape}`;
}

async function readStoredLogin(userId: string): Promise<StoredLogin | null> {
  const raw = await getRedis()
    .get(loginKey(userId))
    .catch((err: unknown) => {
      console.error(`Failed to read the GitHub sign-in of ${userId}:`, err);
      return null;
    });
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredLogin;
    return {
      ...parsed,
      expiresAt: new Date(parsed.expiresAt),
    };
  } catch (err) {
    console.error(`Failed to parse the GitHub sign-in of ${userId}:`, err);
    return null;
  }
}

async function writeStoredLogin(userId: string, login: StoredLogin): Promise<void> {
  await getRedis()
    .set(loginKey(userId), JSON.stringify(login), "EX", LOGIN_TTL_SECONDS)
    .catch((err: unknown) => {
      console.error(`Failed to store the GitHub sign-in of ${userId}:`, err);
    });
}

function toDeviceLogin(login: StoredLogin): GithubDeviceLogin {
  return {
    userCode: login.userCode,
    verificationUri: login.verificationUri,
    expiresAt: login.expiresAt,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Re-exported so callers do not import the client just for a type. */
export type { GithubInstallationSummary };
