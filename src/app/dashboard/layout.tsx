import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { DashboardNav } from "@/components/layout/dashboard-nav";
import { ImpersonationBanner } from "@/components/layout/impersonation-banner";

// All dashboard pages require auth and redirect if unauthenticated
// no point prerendering them as static content.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/auth/login");
  }

  return (
    <AppShell nav={<DashboardNav />} banner={<ImpersonationBanner />}>
      {children}
    </AppShell>
  );
}
