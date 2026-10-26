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
 * The page is rendered once. The frame reshapes itself (`.shell-frame` in
 * globals.css): a column with the bottom bar on phones, a sidebar row on
 * desktop. Rendering the page per breakpoint used to mount every view twice:
 * two composers, two SSE streams, two sets of form state.
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
          <div className="shell-frame">
            {/* Desktop sidebar. on phones the bottom bar is the navigation */}
            <div className="hidden shrink-0 md:flex">{nav}</div>
            <main className="shell-main">
              {banner}
              {/* Page wrapper. flex-1 fills the remaining space */}
              <div className="min-h-0 flex-1">
                <div className="page-wrapper h-full">
                  {/* Inner. h-full fills page-wrapper so child pages can flex-1 */}
                  <div className="flex h-full flex-col gap-4 overflow-hidden">{children}</div>
                </div>
              </div>
            </main>
          </div>
          <MobileNav />
        </div>
      </SidebarNavProvider>
    </KeyboardShortcutsProvider>
  );
}
