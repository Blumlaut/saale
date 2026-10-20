import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

/**
 * Build authenticated headers for GitHub API requests.
 */
function makeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "Content-Type": "application/json",
  };
}

/**
 * Fetch from the GitHub API with authentication.
 */
async function githubFetch(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<unknown> {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...makeHeaders(token),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body || res.statusText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

/**
 * Look up a user's GitHub account and return the decrypted token.
 * Throws if not configured or disabled.
 */
export async function getGitHubToken(userId: string): Promise<{
  token: string;
  account: {
    id: string;
    username: string | null;
    avatarUrl: string | null;
    enabled: boolean;
  };
} | null> {
  const account = await prisma.gitHubAccount.findUnique({
    where: { userId },
    select: {
      id: true,
      encryptedToken: true,
      username: true,
      avatarUrl: true,
      enabled: true,
    },
  });

  if (!account) return null;

  return {
    token: decrypt(account.encryptedToken),
    account: {
      id: account.id,
      username: account.username,
      avatarUrl: account.avatarUrl,
      enabled: account.enabled,
    },
  };
}

/**
 * Validate a GitHub personal access token by calling GET /user.
 * Returns user info if valid, throws if invalid.
 */
export async function validateGitHubToken(token: string): Promise<{
  login: string;
  avatarUrl: string;
  id: number;
}> {
  const user = await githubFetch("/user", token);
  const data = user as Record<string, unknown>;

  if (!data.login) {
    throw new Error("Invalid GitHub token. could not retrieve user info");
  }

  return {
    login: data.login as string,
    avatarUrl: (data.avatar_url as string) ?? "",
    id: data.id as number,
  };
}

/**
 * Get GH_TOKEN env var value for a user (for terminal injection).
 * Returns null if GitHub is not configured or disabled.
 */
export async function getGitHubEnv(userId: string): Promise<Record<string, string> | null> {
  const result = await getGitHubToken(userId);
  if (!result || !result.account.enabled) return null;

  return { GH_TOKEN: result.token };
}
