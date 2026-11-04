import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLatestRelease,
  isUpdateAvailable,
  resetLatestReleaseCache,
  type LatestRelease,
} from "@/lib/updates/release";

/** What the release workflow publishes: a `CHANGELOG.md` section as the body. */
const RELEASE = {
  tag_name: "2026.11.4",
  html_url: "https://github.com/Blumlaut/saale/releases/tag/2026.11.4",
  published_at: "2026-11-04T03:17:00Z",
  body: "## 2026.11.4 - 2026-11-04\n\n- add an arrow when a newer release is out (a1b2c3d)\n",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function release(version: string): LatestRelease {
  return { version, date: "2026-11-04", items: [], url: "" };
}

beforeEach(() => {
  resetLatestReleaseCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getLatestRelease", () => {
  it("reads the tag, the date and the commits from the release body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(RELEASE));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getLatestRelease()).resolves.toEqual({
      version: "2026.11.4",
      date: "2026-11-04",
      items: [{ text: "add an arrow when a newer release is out", commit: "a1b2c3d" }],
      url: "https://github.com/Blumlaut/saale/releases/tag/2026.11.4",
    });
  });

  it("falls back to the publish date when the body has no section", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ ...RELEASE, body: "Notes elsewhere." })),
    );

    const latest = await getLatestRelease();

    expect(latest?.date).toBe("2026-11-04");
    expect(latest?.items).toEqual([]);
  });

  it("answers null when the repository has no release, or GitHub is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    await expect(getLatestRelease()).resolves.toBeNull();

    resetLatestReleaseCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));
    await expect(getLatestRelease()).resolves.toBeNull();
  });

  it("serves a second caller from the cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(RELEASE));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([getLatestRelease(), getLatestRelease()]);
    await getLatestRelease();

    expect(first?.version).toBe("2026.11.4");
    expect(second?.version).toBe("2026.11.4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("remembers a failure, so a deployment without outbound access does not retry every load", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getLatestRelease()).toBeNull();
    expect(await getLatestRelease()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("isUpdateAvailable", () => {
  it("is true only when the published release is newer than the running one", () => {
    expect(isUpdateAvailable(release("2026.11.4"), "2026.11.3")).toBe(true);
    expect(isUpdateAvailable(release("2026.11.10"), "2026.11.9")).toBe(true);
    expect(isUpdateAvailable(release("2026.11.3"), "2026.11.3")).toBe(false);
    expect(isUpdateAvailable(release("2026.11.2"), "2026.11.3")).toBe(false);
    expect(isUpdateAvailable(null, "2026.11.3")).toBe(false);
  });

  it("never claims an update for a build with no release behind it", () => {
    expect(isUpdateAvailable(release("2026.11.4"), "dev")).toBe(false);
  });
});
