import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { classifyRedditUrl, fetchRedditUrl, isRedditHost } from "@/lib/web/reddit";

// ─── Fixtures ──────────────────────────────────────────────────

const POST = {
  id: "1vwx6yw",
  title: "Am i Cooked",
  author: "testuser",
  score: 42,
  num_comments: 2,
  created_utc: 1787561338,
  url: "https://example.com/photo.jpg",
  selftext: "Just posted my latest work, be honest.",
  permalink: "/r/pics/comments/1vwx6yw/am_i_cooked/",
  subreddit: "pics",
  over_18: false,
  spoiler: false,
  removed_by_category: null,
};

const COMMENT_TREE = [
  {
    kind: "t1",
    data: {
      id: "abc111",
      author: "commenter1",
      body: "This is great work!",
      score: 10,
      created_utc: 1787561400,
    },
    children: [
      {
        kind: "t1",
        data: {
          id: "def222",
          author: "testuser",
          body: "Thanks!",
          score: 5,
          created_utc: 1787561500,
        },
        children: [],
      },
    ],
  },
  { kind: "more", children: ["x1", "x2"] },
];

const ARCHIVE_HTML = `<!DOCTYPE html>
<html lang="en-US">
<head>
  <meta charset="utf-8">
  <meta property="og:title" content="Am i Cooked : pics">
  <title>Am i Cooked : pics</title>
</head>
<body>
  <div id="main">
    <h1 class="entry-title">Am i Cooked</h1>
    <div class="md"><p>Just posted my latest work, be honest.</p></div>
    <div class="comments"><p>Great work! This is a solid post.</p></div>
  </div>
</body>
</html>`;

// ─── Helpers ───────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A Response whose `url` is controllable (real Response.url is read-only). */
function responseWithUrl(
  url: string,
  body: string,
  status = 200,
  contentType = "text/html; charset=utf-8",
): Response {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    url,
    headers: new Headers({ "content-type": contentType }),
    text: async () => body,
  } as unknown as Response;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

describe("isRedditHost", () => {
  it("matches reddit content hosts", () => {
    expect(isRedditHost("www.reddit.com")).toBe(true);
    expect(isRedditHost("old.reddit.com")).toBe(true);
    expect(isRedditHost("reddit.com")).toBe(true);
    expect(isRedditHost("NP.Reddit.com")).toBe(true); // case-insensitive
  });

  it("matches shortlink and media hosts", () => {
    expect(isRedditHost("redd.it")).toBe(true);
    expect(isRedditHost("i.redd.it")).toBe(true);
    expect(isRedditHost("preview.redd.it")).toBe(true);
  });

  it("rejects lookalike and unrelated hosts", () => {
    expect(isRedditHost("google.com")).toBe(false);
    expect(isRedditHost("notreddit.com")).toBe(false);
    expect(isRedditHost("reddit.com.evil.com")).toBe(false);
    expect(isRedditHost("redd.it.evil.com")).toBe(false);
  });
});

describe("classifyRedditUrl", () => {
  it("classifies post URLs in all common forms", () => {
    const cases = [
      "https://www.reddit.com/r/pics/comments/1vwx6yw/am_i_cooked/",
      "https://old.reddit.com/r/pics/comments/1vwx6yw.json",
      "https://np.reddit.com/comments/xyz987",
      "https://www.reddit.com/r/pics/comments/1vwx6yw/am_i_cooked/abc123/",
    ];
    for (const url of cases) {
      expect(classifyRedditUrl(url)).toEqual(
        expect.objectContaining({
          kind: "post",
          postId: url.includes("xyz987") ? "xyz987" : "1vwx6yw",
        }),
      );
    }
  });

  it("classifies subreddit URLs", () => {
    expect(classifyRedditUrl("https://www.reddit.com/r/pics/")).toEqual(
      expect.objectContaining({ kind: "subreddit", subreddit: "pics" }),
    );
    expect(classifyRedditUrl("https://www.reddit.com/r/pics/hot/")).toEqual(
      expect.objectContaining({ kind: "subreddit", subreddit: "pics" }),
    );
    // /r/<sub>/comments listing page
    expect(classifyRedditUrl("https://www.reddit.com/r/pics/comments")).toEqual(
      expect.objectContaining({ kind: "subreddit", subreddit: "pics" }),
    );
  });

  it("classifies user profile URLs", () => {
    expect(classifyRedditUrl("https://www.reddit.com/user/SomeUser")).toEqual(
      expect.objectContaining({ kind: "user", username: "SomeUser" }),
    );
    expect(classifyRedditUrl("https://www.reddit.com/u/SomeUser")).toEqual(
      expect.objectContaining({ kind: "user", username: "SomeUser" }),
    );
  });

  it("classifies media and shortlink URLs", () => {
    expect(classifyRedditUrl("https://i.redd.it/abc123xyz.png")).toEqual(
      expect.objectContaining({ kind: "media" }),
    );
    expect(classifyRedditUrl("https://redd.it/abc123")).toEqual(
      expect.objectContaining({ kind: "shortlink" }),
    );
  });

  it("classifies unsupported reddit pages", () => {
    expect(classifyRedditUrl("https://www.reddit.com/search/?q=test")).toEqual(
      expect.objectContaining({ kind: "unsupported" }),
    );
    expect(classifyRedditUrl("https://www.reddit.com/messages/")).toEqual(
      expect.objectContaining({ kind: "unsupported" }),
    );
  });

  it("returns null for non-reddit URLs", () => {
    expect(classifyRedditUrl("https://example.com/r/pics/comments/123")).toBeNull();
    expect(classifyRedditUrl("not a url")).toBeNull();
  });
});

describe("fetchRedditUrl", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches a post with its comment tree via Arctic Shift", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/posts/ids?ids=1vwx6yw")) {
        return jsonResponse({ data: [POST] });
      }
      if (url.includes("/api/comments/tree?link_id=t3_1vwx6yw")) {
        return jsonResponse({ data: COMMENT_TREE });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchRedditUrl(
      "https://www.reddit.com/r/pics/comments/1vwx6yw/am_i_cooked/",
    );

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.title).toBe("Am i Cooked");
    expect(result.siteName).toBe("reddit.com");
    expect(result.author).toBe("u/testuser");
    expect(result.finalUrl).toBe("https://www.reddit.com/r/pics/comments/1vwx6yw/am_i_cooked/");
    expect(result.publishedDate).toBe("2026-08-24");

    const content = result.content;
    expect(content).toContain("# Am i Cooked");
    expect(content).toContain("in r/pics");
    expect(content).toContain("Just posted my latest work, be honest.");
    expect(content).toContain("**Comments (2):**");
    expect(content).toContain("u/commenter1");
    expect(content).toContain("This is great work!");
    // top-level comments are unquoted, replies are indented with quotes
    const topIndex = content.indexOf("\nThis is great work!");
    const nestedIndex = content.indexOf("> Thanks!");
    expect(topIndex).toBeGreaterThan(-1);
    expect(nestedIndex).toBeGreaterThan(topIndex);
    // collapsed group
    expect(content).toContain("(and 2 more comments not shown)");
    expect(content).toContain("Arctic Shift archive");
  });

  it("skips the comment tree call when the post has no comments", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/posts/ids")) {
        return jsonResponse({ data: [{ ...POST, num_comments: 0 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchRedditUrl(
      "https://www.reddit.com/r/pics/comments/1vwx6yw/am_i_cooked/",
    );

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content).not.toContain("**Comments");
  });

  it("renders collapsed comment groups and caps long threads", async () => {
    const manyComments = Array.from({ length: 60 }, (_, i) => ({
      kind: "t1",
      data: {
        id: `c${i}`,
        author: `user${i}`,
        body: `Comment number ${i}`,
        score: 1,
        created_utc: 1787561000 + i,
      },
      children: [],
    }));

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/posts/ids")) {
        return jsonResponse({ data: [{ ...POST, num_comments: 60 }] });
      }
      if (url.includes("/api/comments/tree")) {
        return jsonResponse({ data: manyComments });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchRedditUrl("https://www.reddit.com/r/pics/comments/1vwx6yw/");

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.content).toContain("**Comments (60):**");
    expect(result.content).toContain("Comment number 0");
    expect(result.content).not.toContain("Comment number 50");
    expect(result.content).toContain("(10 more comments not shown)");
  });

  it("falls back to web.archive.org when Arctic Shift has no data", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("arctic-shift.photon-reddit.com")) {
        return jsonResponse({ data: null, error: "Query timed out" }, 200);
      }
      if (url.startsWith("https://web.archive.org/")) {
        return responseWithUrl(
          "https://web.archive.org/web/20260801000000/https://old.reddit.com/r/pics/comments/1vwx6yw/am_i_cooked/",
          ARCHIVE_HTML,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchRedditUrl(
      "https://www.reddit.com/r/pics/comments/1vwx6yw/am_i_cooked/",
    );

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.siteName).toBe("web.archive.org");
    expect(result.finalUrl).toContain("web.archive.org");
    expect(result.content).toContain("Just posted my latest work, be honest.");
    expect(result.content).toContain("web.archive.org snapshot of");
    // archive snapshot lookup should prefer the server-rendered old.reddit.com
    const archiveCall = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.startsWith("https://web.archive.org/"));
    expect(archiveCall).toContain("old.reddit.com");
  });

  it("returns reddit_unavailable when both Arctic Shift and the archive fail", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("arctic-shift.photon-reddit.com")) {
        throw new Error("network down");
      }
      if (url.startsWith("https://web.archive.org/")) {
        return responseWithUrl(url, "404", 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchRedditUrl(
      "https://www.reddit.com/r/pics/comments/1vwx6yw/am_i_cooked/",
    );

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.code).toBe("reddit_unavailable");
    expect(result.retryable).toBe(false);
    expect(result.error).toContain("Arctic Shift");
    expect(result.error).toContain("web.archive.org");
    // every failure branch must log
    expect(errorSpy).toHaveBeenCalled();
  });

  it("lists newest subreddit posts", async () => {
    const posts = [
      POST,
      {
        ...POST,
        id: "1vwaaaa",
        title: "Older post",
        selftext: "",
        url: null,
        score: 7,
        num_comments: 0,
        created_utc: 1787550000,
      },
    ];
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/posts/search") && url.includes("subreddit=pics")) {
        return jsonResponse({ data: posts });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchRedditUrl("https://www.reddit.com/r/pics/hot/");

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.title).toBe("r/pics");
    expect(result.content).toContain("# r/pics");
    expect(result.content).toContain("**Am i Cooked**");
    expect(result.content).toContain("**Older post**");
    expect(result.content).toContain("Newest posts via Arctic Shift");
  });

  it("lists recent posts and comments for a user", async () => {
    const userPost = {
      ...POST,
      id: "p1",
      title: "My post",
      selftext: "hello world",
      permalink: "/r/pics/comments/p1/my_post/",
    };
    const userComment = {
      id: "c1",
      author: "testuser",
      body: "A comment I made.",
      score: 3,
      created_utc: 1787561400,
      subreddit: "AskHistorians",
      permalink: "/r/AskHistorians/comments/pp1/some_post/c1/",
    };
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/posts/search") && url.includes("author=testuser")) {
        return jsonResponse({ data: [userPost] });
      }
      if (url.includes("/api/comments/search") && url.includes("author=testuser")) {
        return jsonResponse({ data: [userComment] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchRedditUrl("https://www.reddit.com/user/testuser");

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.title).toBe("u/testuser");
    expect(result.content).toContain("**Recent posts (1):**");
    expect(result.content).toContain("**My post**");
    expect(result.content).toContain("**Recent comments (1):**");
    expect(result.content).toContain("A comment I made.");
  });

  it("resolves redd.it shortlinks before fetching", async () => {
    const finalUrl = "https://www.reddit.com/r/pics/comments/1vwx6yw/am_i_cooked/";
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://redd.it/abc123") {
        return {
          ok: true,
          status: 200,
          url: finalUrl,
          body: { cancel: () => Promise.resolve() },
        } as unknown as Response;
      }
      if (url.includes("/api/posts/ids?ids=1vwx6yw")) {
        return jsonResponse({ data: [{ ...POST, num_comments: 0 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchRedditUrl("https://redd.it/abc123");

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.title).toBe("Am i Cooked");
  });

  it("returns reddit_shortlink_failed when the shortlink cannot be resolved", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error("connection refused"));

    const result = await fetchRedditUrl("https://redd.it/abc123");

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.code).toBe("reddit_shortlink_failed");
    expect(result.retryable).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("rejects media URLs without any network call", async () => {
    const result = await fetchRedditUrl("https://i.redd.it/abc123xyz.png");

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.code).toBe("reddit_media_url");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported reddit pages without any network call", async () => {
    const result = await fetchRedditUrl("https://www.reddit.com/search/?q=test");

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.code).toBe("reddit_unsupported_url");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("truncates content to maxChars", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/posts/ids")) {
        return jsonResponse({ data: [{ ...POST, num_comments: 0 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await fetchRedditUrl("https://www.reddit.com/r/pics/comments/1vwx6yw/", {
      maxChars: 50,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.content.length).toBeLessThanOrEqual(50 + 20);
    expect(result.content).toContain("... [truncated]");
  });
});
