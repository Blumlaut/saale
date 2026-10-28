import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { DashboardNav } from "@/components/layout/dashboard-nav";
import { ImpersonationBanner } from "@/components/layout/impersonation-banner";
import { loginPath, PATH_HEADER } from "@/lib/auth/redirect";

// All dashboard pages require auth and redirect if unauthenticated
// no point prerendering them as static content.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    // Signing in sends the visitor back here, prompt and all.
    redirect(loginPath(requestHeaders.get(PATH_HEADER) ?? "/dashboard/chat"));
  }

  return (
    <AppShell nav={<DashboardNav />} banner={<ImpersonationBanner />}>
      {children}
    </AppShell>
  );
}
