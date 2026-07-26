import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
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

  return (
    <div className="dashboard-layout h-dvh overflow-hidden">
      {/* Desktop layout */}
      <div className="hidden h-full gap-6 overflow-hidden p-4 md:flex md:p-5 lg:p-6">
        <AdminNav />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="page-wrapper">
            <div className="flex h-full flex-col gap-6 overflow-hidden">{children}</div>
          </div>
        </main>
      </div>

      {/* Mobile layout */}
      <div className="mobile-shell md:hidden">
        <main className="flex flex-col overflow-hidden p-4 pb-20">
          <div className="page-wrapper">
            <div className="flex h-full flex-col gap-4 overflow-hidden">{children}</div>
          </div>
        </main>
      </div>
    </div>
  );
}
