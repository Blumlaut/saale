import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shared Chat — Saale",
  description: "Viewing a shared conversation",
};

/**
 * Minimal layout for /share/* pages.
 *
 * Nested inside the root layout (src/app/layout.tsx) which provides
 * ThemeProvider, fonts, ErrorBoundary, and Toaster. No duplicate
 * <html>/<body> or providers — those belong only in the root layout.
 */
export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen">{children}</div>;
}
