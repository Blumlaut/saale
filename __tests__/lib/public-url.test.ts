import { afterEach, describe, expect, it } from "vitest";
import { getPublicUrl, getRequestPublicUrl } from "@/lib/public-url";

/** A request that reached the app behind a proxy at a public hostname. */
function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("getRequestPublicUrl", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env.BETTER_AUTH_URL = env.BETTER_AUTH_URL;
    process.env.AUTH_TRUSTED_ORIGINS = env.AUTH_TRUSTED_ORIGINS;
  });

  it("keeps a configured public URL", () => {
    process.env.BETTER_AUTH_URL = "https://saale.example";
    process.env.AUTH_TRUSTED_ORIGINS = "";

    expect(getRequestPublicUrl(request("https://preview.example/dashboard"))).toBe(
      "https://saale.example",
    );
  });

  it("answers with the host the request arrived on when the configured one is loopback", () => {
    process.env.BETTER_AUTH_URL = "http://localhost:3630";
    process.env.AUTH_TRUSTED_ORIGINS = "https://*.chat.blumlaut.me";

    const answer = getRequestPublicUrl(
      request("https://ignored.test/api/mcp/servers/srv/oauth/start", {
        host: "3630-abc.preview.chat.blumlaut.me",
        "x-forwarded-proto": "https",
      }),
    );

    expect(answer).toBe("https://3630-abc.preview.chat.blumlaut.me");
  });

  it("keeps the configured URL for a host the instance does not trust", () => {
    process.env.BETTER_AUTH_URL = "http://localhost:3630";
    process.env.AUTH_TRUSTED_ORIGINS = "https://*.chat.blumlaut.me";

    expect(
      getRequestPublicUrl(request("http://localhost:3630/api", { host: "evil.example" })),
    ).toBe(getPublicUrl());
  });

  it("keeps the configured URL for a request that arrived on loopback", () => {
    process.env.BETTER_AUTH_URL = "http://localhost:3630";
    process.env.AUTH_TRUSTED_ORIGINS = "http://localhost:3630";

    expect(
      getRequestPublicUrl(request("http://localhost:3630/api", { host: "localhost:3630" })),
    ).toBe(getPublicUrl());
  });
});
