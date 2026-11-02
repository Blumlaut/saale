import type { MetadataRoute } from "next";

/**
 * Every page needs an account except a shared chat, which is unlisted rather
 * than private. Crawlers keep out of the app, and they may still fetch a share
 * link so the `X-Robots-Tag` header from the middleware reaches them.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/share/",
      disallow: "/",
    },
  };
}
