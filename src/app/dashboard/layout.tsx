import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DashboardNav } from "@/components/layout/dashboard-nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/auth/login");
  }

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-[1600px] gap-6 p-4 md:p-5 lg:p-6">
        <DashboardNav />
        <main className="min-w-0 flex-1">
          <div className="flex flex-col gap-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
