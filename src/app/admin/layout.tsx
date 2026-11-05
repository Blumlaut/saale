import type { Metadata } from "next";
import { getAuth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions/check";
import { AppShell } from "@/components/layout/app-shell";
import { AdminNav } from "@/components/admin/admin-nav";
import { enforceTwoFactorSetup } from "@/lib/auth/two-factor-policy";
import { PATH_HEADER } from "@/lib/auth/redirect";
import { getWorkspaceName } from "@/lib/branding/workspace";

// All admin pages require auth + admin access and redirect if unauthenticated
// no point prerendering them as static content.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: await getWorkspaceName() };
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    redirect("/auth/login");
  }

  await enforceTwoFactorSetup(session, requestHeaders.get(PATH_HEADER) ?? "");

  if (!(await hasPermission(session.user.id, "admin", "access"))) {
    redirect("/dashboard/chat");
  }

  return (
    <AppShell nav={<AdminNav workspaceName={await getWorkspaceName()} />}>{children}</AppShell>
  );
}
