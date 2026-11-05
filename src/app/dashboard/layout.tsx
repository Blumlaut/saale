import type { Metadata } from "next";
import { getAuth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { DashboardNav } from "@/components/layout/dashboard-nav";
import { ImpersonationBanner } from "@/components/layout/impersonation-banner";
import { loginPath, PATH_HEADER } from "@/lib/auth/redirect";
import { enforceTwoFactorSetup } from "@/lib/auth/two-factor-policy";
import { getWorkspaceName } from "@/lib/branding/workspace";

// All dashboard pages require auth and redirect if unauthenticated
// no point prerendering them as static content.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: await getWorkspaceName() };
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    // Signing in sends the visitor back here, prompt and all.
    redirect(loginPath(requestHeaders.get(PATH_HEADER) ?? "/dashboard/chat"));
  }

  await enforceTwoFactorSetup(session, requestHeaders.get(PATH_HEADER) ?? "");

  return (
    <AppShell
      nav={<DashboardNav workspaceName={await getWorkspaceName()} />}
      banner={<ImpersonationBanner />}
    >
      {children}
    </AppShell>
  );
}
