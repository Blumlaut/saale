import type { MetadataRoute } from "next";

/**
 * Every page needs an account, so crawlers get nothing here. A share link opens
 * without one, and the middleware puts `X-Robots-Tag: noindex` on it for a
 * crawler that reaches it anyway.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
