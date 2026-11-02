import type { Metadata } from "next";
import { getWorkspaceName } from "@/lib/branding/workspace";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: `Shared Chat. ${await getWorkspaceName()}`,
    description: "Viewing a shared conversation",
    // A share link is unlisted, so it stays out of search results.
    robots: { index: false, follow: false, nocache: true },
  };
}

/**
 * Minimal layout for /share/* pages.
 *
 * Nested inside the root layout (src/app/layout.tsx) which provides
 * ThemeProvider, fonts, ErrorBoundary, and Toaster. No duplicate
 * <html>/<body> or providers. those belong only in the root layout.
 */
export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen">{children}</div>;
}
