import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DashboardNav } from "@/components/layout/dashboard-nav";
import { MobileNav } from "@/components/layout/mobile-nav";
import { ImpersonationBanner } from "@/components/layout/impersonation-banner";
import { KeyboardShortcutsProvider } from "@/components/providers/keyboard-shortcuts-provider";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/auth/login");
  }

  return (
    <KeyboardShortcutsProvider>
      {/* App shell — fixed to viewport, all scrolling is internal to panels */}
      <div className="dashboard-layout h-dvh overflow-hidden">
        {/* Desktop layout: sidebar + main, flex chain fills viewport */}
        <div className="hidden h-full gap-6 overflow-hidden p-4 md:flex md:p-5 lg:p-6">
          <DashboardNav />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {/* Impersonation banner — always visible, never scrolls */}
            <ImpersonationBanner />
            {/* Page wrapper — flex-1 fills remaining space */}
            <div className="min-h-0 flex-1">
              <div className="page-wrapper h-full">
                {/* Inner — h-full fills page-wrapper so child pages can flex-1 */}
                <div className="flex h-full flex-col gap-6 overflow-hidden">{children}</div>
              </div>
            </div>
          </main>
        </div>

        {/* Mobile layout: full-width content + bottom nav */}
        <div className="mobile-shell md:hidden">
          <main className="flex flex-col overflow-hidden p-4 pb-20">
            {/* Impersonation banner — always visible, never scrolls */}
            <ImpersonationBanner />
            {/* Page wrapper — flex-1 fills remaining space */}
            <div className="min-h-0 flex-1">
              <div className="page-wrapper">
                {/* Inner — h-full fills page-wrapper so child pages can flex-1 */}
                <div className="flex h-full flex-col gap-4 overflow-hidden">{children}</div>
              </div>
            </div>
          </main>
          <MobileNav />
        </div>
      </div>
    </KeyboardShortcutsProvider>
  );
}
