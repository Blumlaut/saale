import { NextRequest } from "next/server";

import { describe, expect, it } from "vitest";

import robots from "@/app/robots";
import { middleware } from "@/middleware";

/**
 * A share link opens without an account, so anyone holding it can read the
 * conversation. Search engines must not add it to their index: `robots.txt`
 * keeps them out of the app while letting them fetch a share link, and the
 * page carries its own noindex for the crawler that does.
 */

async function headersFor(path: string) {
  const response = await middleware(new NextRequest(new URL(path, "http://localhost")));
  return response.headers;
}

describe("share links and crawlers", () => {
  it("marks the shared page as noindex", async () => {
    const headers = await headersFor("/share/12b3a4e31bd2be9dca74b2a44e4ac983");

    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  });

  it("marks the shared messages endpoint as noindex", async () => {
    const headers = await headersFor(
      "/api/chat/sessions/share/12b3a4e31bd2be9dca74b2a44e4ac983/messages",
    );

    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  });

  it("leaves dashboard pages without a robots tag", async () => {
    expect((await headersFor("/dashboard/chat")).get("X-Robots-Tag")).toBeNull();
  });

  it("blocks the app and still lets a crawler fetch a share link", () => {
    const { rules } = robots();
    const rule = Array.isArray(rules) ? rules[0] : rules;

    expect(rule?.disallow).toBe("/");
    expect(rule?.allow).toBe("/share/");
  });
});
