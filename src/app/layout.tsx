import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/providers/theme-provider";
import { ErrorBoundary } from "@/components/error-boundary";
import { ServiceWorkerRegistrar } from "@/components/pwa/service-worker-registrar";
import brand from "@/lib/pwa/brand.json";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: brand.name,
  description: brand.description,
  applicationName: brand.name,
  // iOS ignores the manifest's display mode — these tags are how a home-screen
  // install gets its own window and title.
  appleWebApp: {
    capable: true,
    title: brand.shortName,
    statusBarStyle: "default",
  },
  // Next emits the standards-track `mobile-web-app-capable`. iOS 16.4+ reads the
  // manifest's `display` as well, but older versions only honour Apple's legacy
  // tag, so both are sent.
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

/**
 * `viewportFit: "cover"` lets an installed app paint under the status bar and
 * home indicator; the shell compensates with `env(safe-area-inset-*)` padding
 * (see `.app-shell-padding` / `.mobile-shell-content` in globals.css).
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: brand.themeColor.light },
    { media: "(prefers-color-scheme: dark)", color: brand.themeColor.dark },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${geistMono.variable} font-sans`}>
        <ThemeProvider>
          <ErrorBoundary>{children}</ErrorBoundary>
          <Toaster />
        </ThemeProvider>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
