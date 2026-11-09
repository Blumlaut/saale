/**
 * Talking to GitHub as this instance's GitHub App.
 *
 * Everything here is a request and its answer: signing the app JWT, the device
 * flow, refreshing a user token, listing installations, and minting an
 * installation token that is narrowed to one repository. No database, no cache,
 * no retries — `github-app.ts` owns the state and decides when to call in.
 *
 * Two kinds of credential come out of it, and they are not interchangeable:
 *
 * - A **user-to-server** token (`ghu_…`, eight hours, refreshable for six
 *   months) acts as the person who authorized the app, with the permissions
 *   both the app and that person have. Pushes and pull requests made with it
 *   are attributed to them.
 * - An **installation** token (`ghs_…`, one hour) acts as the app on the
 *   account it is installed on. It is what background work uses, and the
 *   endpoint that mints it accepts `repositories` and `permissions` to make a
 *   token narrower than the installation — that is how a coding agent is
 *   confined to the one repository of its chat.
 *
 * GitHub's own limits that shape this file: an app JWT lives at most ten
 * minutes, a device code fifteen, and a device-flow poll must not be faster
 * than the interval GitHub names.
 */

import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";

const API_BASE = "https://api.github.com";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** GitHub rejects a JWT that lives longer than ten minutes. */
const JWT_TTL_SECONDS = 9 * 60;

/** Backdated by a minute, so a slow clock on either side cannot refuse it. */
const JWT_SKEW_SECONDS = 60;

/** No request here is worth waiting on longer than this. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Enough of a refusal to read in a dialog, and no more. */
const MAX_ERROR_BODY = 300;

/** What GitHub asks a caller to identify itself with. */
const USER_AGENT = "saale (+https://github.com/Blumlaut/saale)";
const API_VERSION = "2022-11-28";

/** The credential set an admin saved, already decrypted by the caller. */
export interface GithubAppCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  /** PEM private key of the app. */
  privateKey: string;
}

/** A user-to-server token pair, as the device flow and the refresh return it. */
export interface GithubUserTokens {
  accessToken: string;
  /** Only present when the authorization included `offline_access`. */
  refreshToken: string | null;
  /** Eight hours from issue, when GitHub says so. */
  accessExpiresAt: Date | null;
  /** Six months from issue, when GitHub says so. */
  refreshExpiresAt: Date | null;
}

/** One installation, as `GET /user/installations` lists it. */
export interface GithubInstallationSummary {
  installationId: string;
  accountLogin: string;
  /** "User" or "Organization". */
  accountType: string;
  /** "all" or "selected". */
  repositorySelection: string;
  permissions: Record<string, string> | null;
  /** GitHub suspended it, so no token can be minted for it. */
  suspended: boolean;
}

/** What one installation was granted, as `GET /app` reports it. */
export interface GithubAppIdentity {
  slug: string;
  name: string;
  ownerLogin: string;
  permissions: Record<string, string> | null;
}

/** A minted installation token and the moment it stops working. */
export interface GithubInstallationToken {
  token: string;
  expiresAt: Date;
}

/** How an installation token may be narrowed below the installation's rights. */
export interface GithubTokenScope {
  /** Repository names (not full names) this token may touch. */
  repositories?: readonly string[];
  /** Repository permissions this token gets, e.g. `{ contents: "write" }`. */
  permissions?: Readonly<Record<string, "read" | "write">>;
}

/** A sign-in waiting for the user to type a code in a browser. */
export interface GithubDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** The code dies after this many seconds; GitHub says 900. */
  expiresInSeconds: number;
  /** Minimum seconds between two polls. */
  intervalSeconds: number;
}

/** What one poll of the device flow answered. */
export type GithubDevicePoll =
  /** Nobody typed the code yet; poll again after the interval. */
  | { state: "pending" }
  /** Polled too fast: wait five seconds longer than the interval. */
  | { state: "slow-down" }
  /** The code expired; a new one is needed. */
  | { state: "expired" }
  /** The user refused. */
  | { state: "denied" }
  | { state: "authorized"; tokens: GithubUserTokens };

/**
 * GitHub answered with a refusal.
 *
 * `status` is the HTTP status, or 0 for an OAuth answer that carried an error
 * instead of a token (those come back as 200 with an `error` field).
 */
export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string = "",
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

// ─── The app's own JWT ───────────────────────────────────────────────────────

/**
 * The app's key as PKCS#8, whatever GitHub handed out.
 *
 * GitHub's "Generate a private key" downloads a **PKCS#1** key
 * (`-----BEGIN RSA PRIVATE KEY-----`), while `jose` only imports PKCS#8
 * (`-----BEGIN PRIVATE KEY-----`). Node reads either, so the key is normalised
 * through it rather than asking an admin to convert a file.
 *
 * A stray `\n` sequence — a key copied out of a JSON secret instead of the file
 * — is turned back into a line break, because that copy is the other way this
 * fails and it looks identical to a wrong key.
 */
function pkcs8Pem(pem: string): string {
  const literal = pem.includes("\n") ? pem : pem.replace(/\\n/g, "\n");
  const key = createPrivateKey(literal);
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

/**
 * The JWT that authenticates this instance as the app.
 *
 * `iss` is the app id, and the token lives nine minutes because GitHub rejects
 * anything longer than ten. Every call that acts *as the app* — listing
 * installations of the instance, minting installation tokens — takes one.
 */
export async function createAppJwt(
  app: Pick<GithubAppCredentials, "appId" | "privateKey">,
  now: Date = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000) - JWT_SKEW_SECONDS;

  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(pkcs8Pem(app.privateKey), "RS256");
  } catch (err) {
    console.error("The saved GitHub App private key is not a usable PEM key:", err);
    throw new GithubApiError("The GitHub App private key cannot be read", 0);
  }

  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(app.appId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + JWT_SKEW_SECONDS + JWT_TTL_SECONDS)
    .sign(key);
}

// ─── OAuth: device flow and refresh ──────────────────────────────────────────

/**
 * Ask GitHub for a code the user types into a browser.
 *
 * `offline_access` is what makes GitHub return a refresh token, so a
 * long-running instance does not have to send the user through this again every
 * eight hours. It is the only scope a GitHub App understands.
 */
export async function requestDeviceCode(clientId: string): Promise<GithubDeviceCode> {
  const body = new URLSearchParams({ client_id: clientId, scope: "offline_access" });
  const answer = await postForm(DEVICE_CODE_URL, body);

  const deviceCode = text(answer.device_code);
  const userCode = text(answer.user_code);
  const verificationUri = text(answer.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new GithubApiError("GitHub did not answer with a device code", 0, json(answer));
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresInSeconds: number(answer.expires_in) ?? 900,
    intervalSeconds: Math.max(1, number(answer.interval) ?? 5),
  };
}

/**
 * Ask once whether the user approved a device code.
 *
 * GitHub answers 200 with an `error` field while the sign-in is still open, so
 * every state but a token is mapped here rather than thrown: a caller polls in a
 * loop, and "not yet" is not a failure.
 */
export async function pollDeviceCode(
  clientId: string,
  deviceCode: string,
): Promise<GithubDevicePoll> {
  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const answer = await postForm(ACCESS_TOKEN_URL, body);

  const error = text(answer.error);
  if (error === "authorization_pending") return { state: "pending" };
  if (error === "slow_down") return { state: "slow-down" };
  if (error === "expired_token") return { state: "expired" };
  if (error === "access_denied") return { state: "denied" };
  if (error) {
    // device_flow_disabled, incorrect_client_credentials, and anything GitHub
    // adds later: the admin has to see the reason, not "pending" forever.
    throw new GithubApiError(
      text(answer.error_description) ?? `GitHub refused the sign-in: ${error}`,
      0,
      json(answer),
    );
  }

  const tokens = readTokens(answer);
  if (!tokens) throw new GithubApiError("GitHub approved the code but sent no token", 0);
  return { state: "authorized", tokens };
}

/** Exchange a refresh token for a fresh pair, before the access token expires. */
export async function refreshUserTokens(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GithubUserTokens> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
  });
  const answer = await postForm(ACCESS_TOKEN_URL, body);

  const tokens = readTokens(answer);
  if (!tokens) {
    throw new GithubApiError(
      text(answer.error_description) ?? "GitHub refused the stored refresh token",
      0,
      json(answer),
    );
  }
  return tokens;
}

// ─── Reading GitHub ─────────────────────────────────────────────────────────

/** The app as GitHub knows it: slug, name, owner and granted permissions. */
export async function readAppIdentity(jwt: string): Promise<GithubAppIdentity> {
  const answer = await apiRequest("/app", jwt);
  const owner = asRecord(answer.owner);

  const slug = text(answer.slug);
  const name = text(answer.name);
  if (!slug || !name) {
    throw new GithubApiError("GitHub did not describe the app", 0, json(answer));
  }

  return {
    slug,
    name,
    ownerLogin: text(owner.login) ?? "",
    permissions: stringRecord(answer.permissions),
  };
}

/** The login a user-to-server token belongs to. */
export async function readUserLogin(userToken: string): Promise<string> {
  const answer = await apiRequest("/user", userToken);
  const login = text(answer.login);
  if (!login) throw new GithubApiError("GitHub did not report the account", 0);
  return login;
}

/**
 * The installations this user can reach.
 *
 * `GET /user/installations` answers with the installations the *user* has access
 * to, not with the app's installation list — which is why the sync runs with the
 * user's token: a row here means "this account really may use it".
 */
export async function listInstallations(userToken: string): Promise<GithubInstallationSummary[]> {
  const answer = await apiRequest("/user/installations?per_page=100", userToken);
  const rows = Array.isArray(answer.installations) ? answer.installations : [];

  const installations: GithubInstallationSummary[] = [];
  for (const row of rows) {
    const entry = asRecord(row);
    const account = asRecord(entry.account);
    const id = text(entry.id) ?? number(entry.id)?.toString();
    const accountLogin = text(account?.login);
    if (!id || !accountLogin) continue;

    installations.push({
      installationId: id,
      accountLogin,
      accountType: text(account?.type) ?? "",
      repositorySelection: text(entry.repository_selection) ?? "",
      permissions: stringRecord(entry.permissions),
      suspended: Boolean(entry.suspended_at),
    });
  }
  return installations;
}

/** The repositories a "selected" installation covers, by name. */
export async function listInstallationRepositories(
  userToken: string,
  installationId: string,
): Promise<string[]> {
  const answer = await apiRequest(
    `/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100`,
    userToken,
  );
  const rows = Array.isArray(answer.repositories) ? answer.repositories : [];
  const names: string[] = [];
  for (const row of rows) {
    const name = text(asRecord(row)?.name);
    if (name) names.push(name);
  }
  return names;
}

/** A repository, as the repository picker lists it. */
export interface GithubRepositoryRef {
  /** GitHub's numeric id — what adding to an installation takes. */
  id: string;
  name: string;
  /** `owner/name`. */
  fullName: string;
}

/** A repository the account could hand to an installation, and may it. */
export interface GithubRepositoryChoice extends GithubRepositoryRef {
  /** The account owns it and the user is an admin: only those can be added. */
  canAdmin: boolean;
  /** Which account it belongs to, for grouping a picker by owner. */
  owner: string;
}

/**
 * The repositories one installation covers, with the ids needed to change them.
 *
 * Read with the user's token: GitHub answers with the repositories that user may
 * use through that installation, which is exactly the set Saale should show as
 * "in use".
 */
export async function listInstallationRepositoryRefs(
  userToken: string,
  installationId: string,
): Promise<GithubRepositoryRef[]> {
  const answer = await apiRequest(
    `/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100`,
    userToken,
  );
  return repositoryRefs(Array.isArray(answer.repositories) ? answer.repositories : []);
}

/**
 * The repositories the account can add to an installation.
 *
 * Adding one takes admin access to it, so the list asks GitHub for the user's
 * own and their organizations' repositories and marks which of them qualify.
 * That is the picker's source: a repository the user is merely a member of is
 * not something they can install the app on.
 */
export async function listRepositoryChoices(userToken: string): Promise<GithubRepositoryChoice[]> {
  // `GET /user/repos` answers with an array, which `apiRequest` does not model.
  const raw = await apiRequestList(
    "/user/repos?affiliation=owner,organization_member&per_page=100",
    userToken,
  );

  const choices: GithubRepositoryChoice[] = [];
  for (const row of raw) {
    const entry = asRecord(row);
    const id = text(entry.id) ?? number(entry.id)?.toString();
    const name = text(entry.name);
    const fullName = text(entry.full_name);
    const owner = text(asRecord(entry.owner)?.login);
    if (!id || !name || !fullName || !owner) continue;

    choices.push({
      id,
      name,
      fullName,
      owner,
      canAdmin: Boolean(asRecord(entry.permissions)?.admin),
    });
  }
  return choices;
}

/**
 * Add one repository to an installation.
 *
 * The user's token is what GitHub checks here: the caller must be an admin of
 * that repository. Nothing is trusted from the request beyond the id.
 */
export async function addInstallationRepository(
  userToken: string,
  installationId: string,
  repositoryId: string,
): Promise<void> {
  await apiRequestNoContent(
    `/user/installations/${encodeURIComponent(installationId)}/repositories/${encodeURIComponent(repositoryId)}`,
    userToken,
    "PUT",
  );
}

/**
 * Remove one repository from an installation.
 *
 * GitHub refuses this on an installation that was granted every repository: it
 * has to be switched to "Only select repositories" first, which only the user
 * can do on GitHub's own page.
 */
export async function removeInstallationRepository(
  userToken: string,
  installationId: string,
  repositoryId: string,
): Promise<void> {
  await apiRequestNoContent(
    `/user/installations/${encodeURIComponent(installationId)}/repositories/${encodeURIComponent(repositoryId)}`,
    userToken,
    "DELETE",
  );
}

// ─── Minting ────────────────────────────────────────────────────────────────

/**
 * Mint an installation token, optionally narrowed to specific repositories and
 * permissions.
 *
 * Narrowing never widens: GitHub refuses a repository the installation was not
 * granted and a permission the app was not registered with. That is what makes
 * it safe to hand a coding agent a token for exactly its chat's repository.
 */
export async function createInstallationToken(options: {
  jwt: string;
  installationId: string;
  scope?: GithubTokenScope;
}): Promise<GithubInstallationToken> {
  const payload: Record<string, unknown> = {};
  if (options.scope?.repositories?.length) {
    payload.repositories = [...options.scope.repositories];
  }
  if (options.scope?.permissions) {
    payload.permissions = { ...options.scope.permissions };
  }

  const answer = await apiRequest(
    `/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`,
    options.jwt,
    { method: "POST", body: JSON.stringify(payload) },
  );

  const token = text(answer.token);
  const expiresAt = date(answer.expires_at);
  if (!token || !expiresAt) {
    throw new GithubApiError("GitHub minted no installation token", 0, json(answer));
  }
  return { token, expiresAt };
}

// ─── Plumbing ───────────────────────────────────────────────────────────────

/** One authenticated call against the REST API. */
async function apiRequest(
  path: string,
  token: string,
  init: { method?: "GET" | "POST" | "DELETE"; body?: string } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: init.body } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  return readAnswer(response, `${init.method ?? "GET"} ${API_BASE}${path}`);
}

/** A GET whose answer is a JSON array, which `apiRequest` does not model. */
async function apiRequestList(path: string, token: string): Promise<unknown[]> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new GithubApiError(
      refusalMessage(parseJson(raw), raw) ?? `GitHub refused GET ${path} (${response.status})`,
      response.status,
      raw.slice(0, MAX_ERROR_BODY),
    );
  }

  const parsed: unknown = raw.trim() ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? parsed : [];
}

/** A call that answers 204 with no body. */
async function apiRequestNoContent(
  path: string,
  token: string,
  method: "PUT" | "DELETE",
): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) return;

  const raw = await response.text();
  throw new GithubApiError(
    refusalMessage(parseJson(raw), raw) ?? `GitHub refused ${method} ${path} (${response.status})`,
    response.status,
    raw.slice(0, MAX_ERROR_BODY),
  );
}

/** The repositories in a `GET .../repositories` answer. */
function repositoryRefs(rows: readonly unknown[]): GithubRepositoryRef[] {
  const refs: GithubRepositoryRef[] = [];
  for (const row of rows) {
    const entry = asRecord(row);
    const id = text(entry.id) ?? number(entry.id)?.toString();
    const name = text(entry.name);
    const fullName = text(entry.full_name);
    if (!id || !name || !fullName) continue;
    refs.push({ id, name, fullName });
  }
  return refs;
}

/** One form-encoded POST to GitHub's OAuth endpoints, which always answer 200. */
async function postForm(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  return readAnswer(response, `POST ${url}`);
}

/** The JSON body of an answer, or a refusal that says what GitHub objected to. */
async function readAnswer(response: Response, what: string): Promise<Record<string, unknown>> {
  const raw = await response.text().catch((err: unknown) => {
    console.error(`Failed to read GitHub's answer to ${what}:`, err);
    return "";
  });

  const parsed = parseJson(raw);
  if (!response.ok) {
    throw new GithubApiError(
      refusalMessage(parsed, raw) ?? `GitHub refused ${what} (${response.status})`,
      response.status,
      raw.slice(0, MAX_ERROR_BODY),
    );
  }
  if (!parsed) {
    throw new GithubApiError(
      `GitHub answered ${what} with something that is not JSON`,
      0,
      raw.slice(0, MAX_ERROR_BODY),
    );
  }
  return parsed;
}

/** GitHub's own words when it has any, cut to something a dialog can show. */
function refusalMessage(parsed: Record<string, unknown> | null, raw: string): string | null {
  if (!parsed) return raw.trim() ? raw.trim().slice(0, MAX_ERROR_BODY) : null;

  const message = text(parsed.message) ?? text(parsed.error_description) ?? text(parsed.error);
  return message ? message.slice(0, MAX_ERROR_BODY) : null;
}

/** The token pair in an OAuth answer, or null when it carries no token. */
function readTokens(answer: Record<string, unknown>): GithubUserTokens | null {
  const accessToken = text(answer.access_token);
  if (!accessToken) return null;

  const expiresIn = number(answer.expires_in);
  const refreshExpiresIn = number(answer.refresh_token_expires_in);
  const now = Date.now();

  return {
    accessToken,
    refreshToken: text(answer.refresh_token) ?? null,
    // Without `expires_in` GitHub intends the token to last indefinitely.
    accessExpiresAt: expiresIn ? new Date(now + expiresIn * 1000) : null,
    refreshExpiresAt: refreshExpiresIn ? new Date(now + refreshExpiresIn * 1000) : null,
  };
}

function parseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch (err) {
    console.error("Failed to parse a JSON answer from GitHub:", err);
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stringRecord(value: unknown): Record<string, string> | null {
  const source = asRecord(value);
  const entries = Object.entries(source).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** A JSON body for an error, cut to what a dialog shows. */
function json(value: Record<string, unknown>): string {
  return JSON.stringify(value).slice(0, MAX_ERROR_BODY);
}
