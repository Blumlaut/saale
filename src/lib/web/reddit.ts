/**
 * Reddit fetch path via the Arctic Shift archive API.
 *
 * Reddit network-blocks datacenter IPs for all of its own endpoints:
 * `.json` endpoints return 403, and HTML pages return 200 with a
 * "Welcome to Reddit" JS shell instead of content. Arctic Shift
 * (arctic-shift.photon-reddit.com) is an open-source, no-auth Reddit data
 * archive (Pushshift successor) with near-real-time ingestion, so it serves
 * posts and full comment trees by ID even for very fresh content.
 *
 * Fallback chain for reddit.com / redd.it URLs:
 *   1. Arctic Shift API (posts, comment trees, subreddit/user listings)
 *   2. web.archive.org snapshot of the original URL (old.reddit.com variant,
 *      which is server-rendered and defuddle-extractable)
 *   3. explicit error, so the LLM stops retrying blocked fetches
 *
 * Content is always rendered as markdown, regardless of the format
 * requested — Reddit content only exists in structured form here.
 */

import { Defuddle } from "defuddle/node";
import type { FetchOutput, FetchResult } from "./fetch";

// ─── Config ────────────────────────────────────────────────────

const ARCTIC_SHIFT_URL = (
  process.env.ARCTIC_SHIFT_URL ?? "https://arctic-shift.photon-reddit.com"
).replace(/\/+$/, "");

const ARCHIVE_ORG_BASE = "https://web.archive.org";
const ARCTIC_TIMEOUT_MS = 20_000;
const ARCHIVE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 50_000;

/** Number of items in subreddit/user listings. */
const LISTING_LIMIT = 25;
/** Max comments rendered for a thread (context budget). */
const MAX_RENDERED_COMMENTS = 50;
/** Nesting depth cap for comment quotes. */
const MAX_COMMENT_DEPTH = 6;
/** Comment tree request size for Arctic Shift. */
const COMMENT_TREE_LIMIT = 1000;

// ─── Types ─────────────────────────────────────────────────────

export type RedditTarget =
  | { kind: "post"; postId: string; url: string }
  | { kind: "subreddit"; subreddit: string; url: string }
  | { kind: "user"; username: string; url: string }
  | { kind: "media"; url: string }
  | { kind: "shortlink"; url: string }
  | { kind: "unsupported"; url: string };

interface ArcticPost {
  id: string;
  title: string | null;
  author: string | null;
  score: number | null;
  num_comments: number | null;
  created_utc: number | null;
  url: string | null;
  selftext: string | null;
  permalink: string | null;
  subreddit: string | null;
  over_18?: boolean;
  spoiler?: boolean;
  removed_by_category?: string | null;
}

interface ArcticComment {
  id: string;
  author: string | null;
  body: string | null;
  score: number | null;
  created_utc: number | null;
  subreddit?: string | null;
  permalink?: string | null;
}

interface ArcticCommentNode {
  /** "t1" = comment, "more" = collapsed comment group. */
  kind: string;
  data?: (ArcticComment & { count?: number }) | null;
  /** Nested comment nodes; "more" nodes carry plain ID strings instead. */
  children?: (ArcticCommentNode | string)[];
}

interface ArcticShiftResponse {
  data: unknown;
  error?: string | null;
}

// ─── URL detection and parsing ─────────────────────────────────

/** Hosts that belong to Reddit (content, shortlinks, or media). */
export function isRedditHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "reddit.com" ||
    host.endsWith(".reddit.com") ||
    host === "redd.it" ||
    host.endsWith(".redd.it")
  );
}

const SUBREDDIT_SORTS = new Set(["hot", "new", "top", "rising", "controversial", "best"]);

/**
 * Classify a URL into a Reddit fetch target.
 * Returns null for non-reddit hosts.
 */
export function classifyRedditUrl(rawUrl: string): RedditTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!isRedditHost(host)) return null;
  if (host === "redd.it") return { kind: "shortlink", url: rawUrl };
  if (host.endsWith(".redd.it")) return { kind: "media", url: rawUrl };

  // Strip .json suffix (LLMs love to append it) and trailing slashes.
  const path = parsed.pathname.replace(/\.json$/, "").replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);

  // /r/<sub>/comments/<post>[/slug][/<comment>]
  if (segments[0] === "r" && segments[1] && segments[2] === "comments") {
    if (segments[3]) return { kind: "post", postId: segments[3], url: rawUrl };
    // /r/<sub>/comments — post listing page
    return { kind: "subreddit", subreddit: segments[1], url: rawUrl };
  }
  // Shortened form: /comments/<post>
  if (segments[0] === "comments" && segments[1]) {
    return { kind: "post", postId: segments[1], url: rawUrl };
  }
  // /r/<sub>[/<sort>]
  if (
    segments[0] === "r" &&
    segments[1] &&
    (segments.length === 2 || (segments.length === 3 && SUBREDDIT_SORTS.has(segments[2] ?? "")))
  ) {
    return { kind: "subreddit", subreddit: segments[1], url: rawUrl };
  }
  // /user/<name> or /u/<name>
  if ((segments[0] === "user" || segments[0] === "u") && segments[1]) {
    return { kind: "user", username: segments[1], url: rawUrl };
  }

  return { kind: "unsupported", url: rawUrl };
}

// ─── Arctic Shift client ───────────────────────────────────────

/**
 * Query the Arctic Shift API. Returns the parsed `data` array.
 * Throws on HTTP errors, query errors, or unexpected shapes.
 */
async function arcticShift(path: string): Promise<unknown[]> {
  const res = await fetch(`${ARCTIC_SHIFT_URL}${path}`, {
    signal: AbortSignal.timeout(ARCTIC_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    console.error("Arctic Shift request failed:", { path, status: res.status });
    throw new Error(`Arctic Shift returned HTTP ${res.status} for ${path}`);
  }

  const json = (await res.json()) as ArcticShiftResponse;

  if (json.error) {
    console.error("Arctic Shift query error:", { path, error: json.error });
    throw new Error(`Arctic Shift query error: ${json.error}`);
  }

  if (!Array.isArray(json.data)) {
    console.error("Arctic Shift unexpected response shape:", {
      path,
      data: json.data,
    });
    throw new Error("Arctic Shift returned an unexpected response shape");
  }

  return json.data;
}

// ─── Rendering ─────────────────────────────────────────────────

function formatRedditDate(createdUtc: number | null): string | null {
  if (!createdUtc) return null;
  return new Date(createdUtc * 1000).toISOString().slice(0, 10);
}

function canonicalPermalink(permalink: string | null): string | null {
  if (!permalink) return null;
  return `https://www.reddit.com${permalink}`;
}

function quote(depth: number): string {
  return "> ".repeat(Math.min(depth, MAX_COMMENT_DEPTH));
}

function countComments(nodes: (ArcticCommentNode | string)[]): number {
  let count = 0;
  for (const node of nodes) {
    if (typeof node === "string") continue; // ID inside a collapsed "more" node
    if (node.kind === "t1" && node.data) count++;
    if (node.children) count += countComments(node.children);
  }
  return count;
}

function renderComments(
  nodes: (ArcticCommentNode | string)[],
  depth: number,
  lines: string[],
  budget: { remaining: number },
): void {
  for (const node of nodes) {
    if (typeof node === "string") continue;

    if (node.kind === "more") {
      const ids = (node.children ?? []).filter((c): c is string => typeof c === "string");
      const count = ids.length > 0 ? ids.length : (node.data?.count ?? 0);
      if (count > 0) {
        lines.push(
          `${quote(depth)}*(and ${count} more comment${count === 1 ? "" : "s"} not shown)*`,
        );
      }
      continue;
    }

    if (budget.remaining <= 0) continue;
    const comment = node.data;
    if (!comment) continue;
    budget.remaining--;

    const prefix = quote(depth);
    const author = comment.author ? `u/${comment.author}` : "[deleted]";
    const date = formatRedditDate(comment.created_utc);
    lines.push(
      `${prefix}${author}${comment.score != null ? ` (${comment.score})` : ""}${date ? ` · ${date}` : ""}:`,
    );
    const body = (comment.body ?? "[deleted]").replace(/\n/g, `\n${prefix}`);
    lines.push(`${prefix}${body}`);

    if (node.children?.length) {
      renderComments(node.children, depth + 1, lines, budget);
    }
  }
}

function postTitle(post: ArcticPost): string {
  if (post.title) return post.title;
  if (post.removed_by_category) {
    return `[removed: ${post.removed_by_category}]`;
  }
  return "[deleted]";
}

function renderPost(post: ArcticPost, commentNodes: (ArcticCommentNode | string)[] | null): string {
  const lines: string[] = [];

  lines.push(`# ${postTitle(post)}`, "");

  const byline: string[] = [post.author ? `by u/${post.author}` : "by [deleted]"];
  if (post.subreddit) byline.push(`in r/${post.subreddit}`);
  const date = formatRedditDate(post.created_utc);
  if (date) byline.push(date);
  if (post.score != null) byline.push(`score ${post.score}`);
  if (post.num_comments != null) byline.push(`${post.num_comments} comments`);
  lines.push(`*${byline.join(" · ")}*`);

  const selftext = (post.selftext ?? "").trim();
  if (selftext && selftext !== "[removed]" && selftext !== "[deleted]") {
    lines.push("", selftext);
  } else if (post.url && post.url.startsWith("http")) {
    lines.push("", `Link: ${post.url}`);
  }

  if (post.spoiler) lines.push("", "*Contains spoilers*");
  if (post.over_18) lines.push("", "*18+ content*");

  if (commentNodes) {
    const total = countComments(commentNodes);
    lines.push("", "---", "", `**Comments (${total}):**`, "");
    const budget = { remaining: MAX_RENDERED_COMMENTS };
    renderComments(commentNodes, 0, lines, budget);
    const rendered = MAX_RENDERED_COMMENTS - budget.remaining;
    if (rendered < total) {
      lines.push("", `*(${total - rendered} more comments not shown)*`);
    }
  }

  const permalink = canonicalPermalink(post.permalink);
  lines.push(
    "",
    "---",
    "",
    "> Source: Arctic Shift archive (near-real-time Reddit data; scores and comment counts are stale until ~36h after posting).",
  );
  if (permalink) lines.push(`> Original: ${permalink}`);

  return lines.join("\n");
}

function renderListingLine(index: number, post: ArcticPost): string[] {
  const title = postTitle(post);
  const date = formatRedditDate(post.created_utc);
  const lines = [
    `${index}. **${title}** — by ${
      post.author ? `u/${post.author}` : "[deleted]"
    }${date ? ` · ${date}` : ""}${
      post.score != null ? ` · score ${post.score}` : ""
    }${post.num_comments != null ? ` · ${post.num_comments} comments` : ""}`,
  ];
  const permalink = canonicalPermalink(post.permalink);
  if (permalink) lines.push(`   ${permalink}`);
  const selftext = (post.selftext ?? "").trim();
  if (selftext && selftext !== "[removed]" && selftext !== "[deleted]") {
    const preview = selftext.slice(0, 200);
    lines.push(`   ${preview}${selftext.length > 200 ? "…" : ""}`);
  }
  return lines;
}

function renderSubreddit(subreddit: string, posts: ArcticPost[]): string {
  const lines: string[] = [
    `# r/${subreddit}`,
    "",
    `*Newest posts via Arctic Shift archive (scores are stale until ~36h after posting). Not "hot" sorting — Arctic Shift does not expose score-sorted feeds.*`,
    "",
  ];
  posts.forEach((post, i) => {
    lines.push(...renderListingLine(i + 1, post), "");
  });
  lines.push("> Source: Arctic Shift archive (near-real-time Reddit data).");
  return lines.join("\n");
}

function renderUser(username: string, posts: ArcticPost[], comments: ArcticComment[]): string {
  const lines: string[] = [
    `# u/${username}`,
    "",
    "*Most recent posts and comments via Arctic Shift archive.*",
    "",
    `**Recent posts (${posts.length}):**`,
    "",
  ];

  if (posts.length === 0) lines.push("_none found_");
  posts.forEach((post, i) => {
    lines.push(...renderListingLine(i + 1, post), "");
  });

  lines.push("", `**Recent comments (${comments.length}):**`, "");
  if (comments.length === 0) lines.push("_none found_");
  for (const comment of comments) {
    const date = formatRedditDate(comment.created_utc);
    const sub = comment.subreddit ? ` in r/${comment.subreddit}` : "";
    const body = (comment.body ?? "[deleted]").replace(/\s+/g, " ").trim();
    const preview = body.slice(0, 300);
    const permalink = canonicalPermalink(comment.permalink ?? null);
    lines.push(
      `- ${permalink ? `[${preview}](${permalink})` : preview}${
        body.length > 300 ? "…" : ""
      }${sub}${date ? ` · ${date}` : ""}`,
    );
  }

  lines.push("", "> Source: Arctic Shift archive (near-real-time Reddit data).");
  return lines.join("\n");
}

// ─── Target fetchers ───────────────────────────────────────────

async function fetchPostTarget(target: {
  kind: "post";
  postId: string;
  url: string;
}): Promise<FetchResult> {
  const posts = (await arcticShift(
    `/api/posts/ids?ids=${encodeURIComponent(target.postId)}`,
  )) as ArcticPost[];
  const post = posts[0];
  if (!post) {
    console.error("Arctic Shift has no data for post:", target.postId);
    throw new Error(`Arctic Shift has no data for post ${target.postId}`);
  }

  let commentNodes: (ArcticCommentNode | string)[] | null = null;
  if ((post.num_comments ?? 0) > 0) {
    const tree = (await arcticShift(
      `/api/comments/tree?link_id=t3_${encodeURIComponent(target.postId)}&limit=${COMMENT_TREE_LIMIT}`,
    )) as (ArcticCommentNode | string)[];
    commentNodes = tree;
  }

  const permalink = canonicalPermalink(post.permalink);
  return {
    url: target.url,
    finalUrl: permalink ?? target.url,
    statusCode: 200,
    mimeType: "text/markdown",
    contentLength: undefined,
    title: post.title ?? undefined,
    author: post.author ? `u/${post.author}` : undefined,
    description: undefined,
    siteName: "reddit.com",
    publishedDate: formatRedditDate(post.created_utc) ?? undefined,
    content: renderPost(post, commentNodes),
    format: "markdown",
  };
}

async function fetchSubredditTarget(target: {
  kind: "subreddit";
  subreddit: string;
  url: string;
}): Promise<FetchResult> {
  const posts = (await arcticShift(
    `/api/posts/search?subreddit=${encodeURIComponent(target.subreddit)}&sort=desc&limit=${LISTING_LIMIT}`,
  )) as ArcticPost[];
  if (posts.length === 0) {
    console.error("Arctic Shift has no data for subreddit:", target.subreddit);
    throw new Error(`Arctic Shift has no data for r/${target.subreddit}`);
  }

  return {
    url: target.url,
    finalUrl: target.url,
    statusCode: 200,
    mimeType: "text/markdown",
    contentLength: undefined,
    title: `r/${target.subreddit}`,
    author: undefined,
    description: undefined,
    siteName: "reddit.com",
    publishedDate: undefined,
    content: renderSubreddit(target.subreddit, posts),
    format: "markdown",
  };
}

async function fetchUserTarget(target: {
  kind: "user";
  username: string;
  url: string;
}): Promise<FetchResult> {
  const enc = encodeURIComponent(target.username);
  const [postsRaw, commentsRaw] = await Promise.all([
    arcticShift(`/api/posts/search?author=${enc}&sort=desc&limit=${LISTING_LIMIT}`),
    arcticShift(`/api/comments/search?author=${enc}&sort=desc&limit=${LISTING_LIMIT}`),
  ]);
  const posts = postsRaw as ArcticPost[];
  const comments = commentsRaw as ArcticComment[];
  if (posts.length === 0 && comments.length === 0) {
    console.error("Arctic Shift has no data for user:", target.username);
    throw new Error(`Arctic Shift has no data for u/${target.username}`);
  }

  return {
    url: target.url,
    finalUrl: target.url,
    statusCode: 200,
    mimeType: "text/markdown",
    contentLength: undefined,
    title: `u/${target.username}`,
    author: undefined,
    description: undefined,
    siteName: "reddit.com",
    publishedDate: undefined,
    content: renderUser(target.username, posts, comments),
    format: "markdown",
  };
}

// ─── web.archive.org fallback ──────────────────────────────────

/**
 * Rewrite www/reddit.com to old.reddit.com for the snapshot lookup —
 * old reddit is server-rendered, so archived snapshots are extractable,
 * while new-UI snapshots are JS shells.
 */
function toOldRedditUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "www.reddit.com" || parsed.hostname === "reddit.com") {
      parsed.hostname = "old.reddit.com";
      return parsed.href;
    }
    return url;
  } catch {
    return url;
  }
}

async function fetchArchiveSnapshot(url: string, maxChars: number): Promise<FetchResult | null> {
  const snapshotUrl = `${ARCHIVE_ORG_BASE}/web/2/${toOldRedditUrl(url)}`;
  try {
    const res = await fetch(snapshotUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!res.ok) {
      console.error("web.archive.org snapshot unavailable:", {
        url,
        status: res.status,
      });
      return null;
    }

    const html = await res.text();
    const extracted = await Defuddle(html, res.url || snapshotUrl, {
      markdown: true,
      removeImages: true,
      includeReplies: "extractors",
      useAsync: false,
    });
    const content = (extracted.contentMarkdown ?? extracted.content ?? "").trim();
    if (!content) {
      console.error("web.archive.org snapshot had no extractable content:", url);
      return null;
    }

    return {
      url,
      finalUrl: res.url || snapshotUrl,
      statusCode: res.status,
      mimeType: "text/html",
      contentLength: html.length,
      title: extracted.title || undefined,
      author: extracted.author || undefined,
      description: extracted.description || undefined,
      siteName: "web.archive.org",
      publishedDate: extracted.published || undefined,
      content: `> Source: web.archive.org snapshot of ${url}\n\n${truncate(content, maxChars)}`,
      format: "markdown",
    };
  } catch (err) {
    console.error("Failed to fetch web.archive.org snapshot:", url, err);
    return null;
  }
}

// ─── Shortlink resolution ──────────────────────────────────────

/** Follow a redd.it shortlink and return the final URL (body is discarded). */
async function resolveShortlink(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(ARCTIC_TIMEOUT_MS),
  });
  await res.body?.cancel().catch(() => {
    // Body cancellation is best-effort; ignore failures.
  });
  return res.url || url;
}

// ─── Helpers ───────────────────────────────────────────────────

function truncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n... [truncated]";
}

function errorResult(
  url: string,
  code: string,
  phase: string,
  error: string,
  retryable = false,
): FetchOutput {
  return {
    error,
    code,
    phase,
    retryable,
    url,
    finalUrl: undefined,
    statusCode: undefined,
  };
}

// ─── Entry point ───────────────────────────────────────────────

/**
 * Fetch a reddit.com / redd.it URL via Arctic Shift, with web.archive.org
 * as fallback. Returns the same FetchOutput shape as the generic fetcher.
 */
export async function fetchRedditUrl(
  rawUrl: string,
  options?: { maxChars?: number },
): Promise<FetchOutput> {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  let target = classifyRedditUrl(rawUrl);
  if (!target) {
    return errorResult(rawUrl, "invalid_url", "validation", `Invalid Reddit URL: ${rawUrl}`);
  }

  if (target.kind === "shortlink") {
    let finalUrl: string;
    try {
      finalUrl = await resolveShortlink(rawUrl);
    } catch (err) {
      console.error("Failed to resolve redd.it shortlink:", rawUrl, err);
      return errorResult(
        rawUrl,
        "reddit_shortlink_failed",
        "connecting",
        `Failed to resolve shortlink ${rawUrl}. Try the full reddit.com URL instead.`,
        true,
      );
    }
    const resolved = classifyRedditUrl(finalUrl);
    if (!resolved) {
      return errorResult(
        rawUrl,
        "reddit_unsupported_url",
        "validation",
        `Shortlink ${rawUrl} resolved to a non-Reddit URL: ${finalUrl}`,
      );
    }
    target = resolved;
  }

  if (target.kind === "media") {
    return errorResult(
      rawUrl,
      "reddit_media_url",
      "validation",
      `Reddit media URLs (i.redd.it / preview.redd.it) serve binary files, not readable text.`,
    );
  }

  if (target.kind === "unsupported") {
    return errorResult(
      rawUrl,
      "reddit_unsupported_url",
      "validation",
      `Unsupported Reddit URL: ${rawUrl}. Only posts, comment pages, subreddits, and user profiles can be fetched (Reddit blocks this server's IP for everything else).`,
    );
  }

  // Unreachable: shortlinks were resolved above. Kept so TypeScript can
  // narrow `target` to post | subreddit | user below.
  if (target.kind === "shortlink") {
    return errorResult(
      rawUrl,
      "reddit_unsupported_url",
      "validation",
      `Unsupported Reddit URL: ${rawUrl}`,
    );
  }

  try {
    const result =
      target.kind === "post"
        ? await fetchPostTarget(target)
        : target.kind === "subreddit"
          ? await fetchSubredditTarget(target)
          : await fetchUserTarget(target);
    return { ...result, content: truncate(result.content, maxChars) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Reddit fetch via Arctic Shift failed, trying web.archive.org:", rawUrl, err);
    const archived = await fetchArchiveSnapshot(rawUrl, maxChars);
    if (archived) return archived;
    return errorResult(
      rawUrl,
      "reddit_unavailable",
      "loading",
      `Reddit content unavailable for ${rawUrl}: Arctic Shift failed (${message}) and no usable web.archive.org snapshot exists. Reddit blocks this server's IP for direct fetches — try a different source.`,
    );
  }
}
