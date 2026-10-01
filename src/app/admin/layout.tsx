import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { AdminNav } from "@/components/admin/admin-nav";

// All admin pages require auth + admin role and redirect if unauthenticated —
// no point prerendering them as static content.
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/auth/login");
  }

  if (session.user?.role !== "admin") {
    redirect("/dashboard/chat");
  }

  return <AppShell nav={<AdminNav />}>{children}</AppShell>;
}
