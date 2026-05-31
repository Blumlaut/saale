import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { DashboardNav } from "@/components/layout/dashboard-nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session) {
    redirect("/auth/login");
  }

  return (
    <div className="bg-background flex h-screen">
      <DashboardNav />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
