import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The generic path uses wreq-js; mock it so tests never touch the network.
vi.mock("wreq-js", () => ({
  fetch: vi.fn(),
}));

import { fetchUrl } from "@/lib/web/fetch";
import * as wreqMod from "wreq-js";

const wreqFetch = vi.mocked(wreqMod.fetch);

type WreqResponse = Awaited<ReturnType<typeof wreqFetch>>;

const POST = {
  id: "1vwx6yw",
  title: "Am i Cooked",
  author: "testuser",
  score: 42,
  num_comments: 0,
  created_utc: 1787561338,
  url: null,
  selftext: "Just posted my latest work, be honest.",
  permalink: "/r/pics/comments/1vwx6yw/am_i_cooked/",
  subreddit: "pics",
};

/** A Response whose `url` is controllable (real Response.url is read-only). */
function htmlResponse(url: string, body: string, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    url,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    text: async () => body,
  } as unknown as Response;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchUrl  reddit routing", () => {
  let globalFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    wreqFetch.mockReset();
    globalFetchMock = vi.fn();
    vi.stubGlobal("fetch", globalFetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes reddit post URLs through Arctic Shift, not the generic fetcher", async () => {
    globalFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("arctic-shift.photon-reddit.com/api/posts/ids")) {
        return jsonResponse({ data: [POST] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    wreqFetch.mockImplementation(async () => {
      throw new Error("wreq must not be used for reddit URLs");
    });

    const result = await fetchUrl({
      url: "https://www.reddit.com/r/pics/comments/1vwx6yw/am_i_cooked/",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.title).toBe("Am i Cooked");
    expect(result.siteName).toBe("reddit.com");
    expect(wreqFetch).not.toHaveBeenCalled();
    const firstCall = String(globalFetchMock.mock.calls[0]?.[0] ?? "");
    expect(firstCall).toContain("arctic-shift");
  });

  it("does not involve Arctic Shift for non-reddit URLs", async () => {
    const page = htmlResponse(
      "https://example.com/article",
      `<!DOCTYPE html>
<html>
<head><meta property="og:title" content="Example Article"><title>Example Article</title></head>
<body><article><h1>Example Article</h1><p>Some readable body text.</p></article></body>
</html>`,
    );
    wreqFetch.mockResolvedValue(page as unknown as WreqResponse);

    const result = await fetchUrl({ url: "https://example.com/article" });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected success");
    expect(result.title).toBe("Example Article");
    expect(result.content).toContain("Some readable body text.");
    expect(globalFetchMock).not.toHaveBeenCalled();
  });

  it("returns bot_block_page for 200 interstitial shells", async () => {
    const shell = htmlResponse(
      "https://example.com/",
      `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="Welcome to Reddit">
  <title>Welcome to Reddit</title>
</head>
<body class="theme-beta"><div><style>.theme-light,:root{--rem360:22.5rem}</style>
<script>function getForbiddenError(){return msg("Your request has been blocked by network security.")}</script>
</div></body>
</html>`,
    );
    wreqFetch.mockResolvedValue(shell as unknown as WreqResponse);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchUrl({ url: "https://example.com/" });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected error");
    expect(result.code).toBe("bot_block_page");
    expect(result.statusCode).toBe(200);
    expect(errorSpy).not.toHaveBeenCalled(); // controlled error path, not a crash
  });
});
