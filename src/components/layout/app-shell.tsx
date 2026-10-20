import { MobileNav } from "@/components/layout/mobile-nav";
import { KeyboardShortcutsProvider } from "@/components/providers/keyboard-shortcuts-provider";
import { SidebarNavProvider } from "@/components/providers/sidebar-nav-provider";

interface AppShellProps {
  /** Desktop navigation. `DashboardNav`, `AdminNav`, … */
  nav: React.ReactNode;
  children: React.ReactNode;
  /** Optional banner pinned above the page content (e.g. impersonation notice). */
  banner?: React.ReactNode;
}

/**
 * The shell every authenticated area renders inside: fixed to the viewport, with
 * all scrolling internal to panels (see AGENTS.md "No External Scroll").
 *
 * The providers the navs read from live here too, so a layout cannot render the
 * sidebar (desktop or bottom bar) without them. Rendering `MobileNav` outside a
 * `SidebarNavProvider` used to crash every admin page with "useSidebarNav must be
 * used within a SidebarNavProvider".
 */
export function AppShell({ nav, children, banner }: AppShellProps) {
  return (
    <KeyboardShortcutsProvider>
      <SidebarNavProvider>
        <div className="dashboard-layout h-dvh overflow-hidden">
          {/* Desktop: sidebar + main, flex chain fills the viewport */}
          <div className="app-shell-padding hidden h-full gap-6 overflow-hidden md:flex">
            {nav}
            <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {banner}
              {/* Page wrapper. flex-1 fills the remaining space */}
              <div className="min-h-0 flex-1">
                <div className="page-wrapper h-full">
                  {/* Inner. h-full fills page-wrapper so child pages can flex-1 */}
                  <div className="flex h-full flex-col gap-6 overflow-hidden">{children}</div>
                </div>
              </div>
            </main>
          </div>

          {/* Mobile: full-width content + bottom nav */}
          <div className="mobile-shell md:hidden">
            <main className="mobile-shell-content flex flex-col overflow-hidden">
              {banner}
              <div className="min-h-0 flex-1">
                <div className="page-wrapper h-full">
                  <div className="flex h-full flex-col gap-4 overflow-hidden">{children}</div>
                </div>
              </div>
            </main>
            <MobileNav />
          </div>
        </div>
      </SidebarNavProvider>
    </KeyboardShortcutsProvider>
  );
}
