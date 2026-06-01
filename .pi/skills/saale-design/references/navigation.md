# Navigation

## Dashboard Navigation

The dashboard uses a **floating glass sidebar**, not an edge-stretched nav.

### Structure

```tsx
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { href: "/dashboard/mail", label: "Mail", icon: Mail },
  { href: "/dashboard/tasks", label: "Tasks", icon: ListTodo },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-6 h-fit w-56">
      <GlassPanel className="shadow-md">
        <GlassPanelContent className="p-3">
          {/* Logo / Brand */}
          <Link href="/dashboard" className="mb-2 flex items-center gap-2 px-3 py-2">
            <ChevronRight className="text-primary h-5 w-5" />
            <span className="text-lg font-bold tracking-tight">Saale</span>
          </Link>

          <Separator className="my-2" />

          {/* Nav Items */}
          <div className="space-y-1">
            {navItems.map((item) => {
              const isActive = pathname.startsWith(item.href);
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
                    isActive
                      ? "bg-white/20 font-medium dark:bg-white/5"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/10",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </GlassPanelContent>
      </GlassPanel>

      {/* User section (outside panel) */}
      <div className="mt-4 px-3">
        <p className="text-muted-foreground text-xs">v0.1.0</p>
      </div>
    </nav>
  );
}
```

### Nav Item Rules

- **Width:** 224px (`w-56`)
- **Position:** `sticky top-6` — floats, doesn't stretch
- **Active state:** Subtle glass highlight + `font-medium`
- **Inactive state:** `text-muted-foreground`, hover shows foreground
- **Icon size:** `h-4 w-4` (16px)
- **Icon + text gap:** `gap-2` (8px)
- **Corner radius:** `rounded-lg` on items, `rounded-2xl` on panel

## Breadcrumbs

For nested views within a section:

```tsx
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

<Breadcrumb>
  <BreadcrumbList>
    <BreadcrumbItem>
      <BreadcrumbLink href="/dashboard/mail">Mail</BreadcrumbLink>
    </BreadcrumbItem>
    <BreadcrumbSeparator />
    <BreadcrumbItem>
      <BreadcrumbPage>Inbox</BreadcrumbPage>
    </BreadcrumbItem>
  </BreadcrumbList>
</Breadcrumb>;
```

- Place above the page heading, inside the content area
- Use sentence case: "Inbox" not "INBOX"

## Mobile Navigation

On screens < 768px, the sidebar becomes a sheet:

```tsx
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Menu } from "lucide-react";

<Sheet>
  <SheetTrigger asChild>
    <Button variant="ghost" size="icon" className="lg:hidden">
      <Menu className="h-5 w-5" />
    </Button>
  </SheetTrigger>
  <SheetContent side="left" className="w-64 p-0">
    {/* Same nav content as desktop sidebar */}
  </SheetContent>
</Sheet>;
```

## Top Bar (Optional)

Some views need a top bar for search or actions:

```tsx
<div className="mb-6 flex items-center justify-between">
  <div>
    <h1 className="text-2xl leading-tight font-semibold tracking-tight">Inbox</h1>
    <p className="text-muted-foreground mt-1 text-sm">3 unread messages</p>
  </div>
  <div className="flex items-center gap-2">
    <Input placeholder="Search..." className="w-64" />
    <ThemeToggle />
    <Button>
      <Plus className="mr-2 h-4 w-4" /> Compose
    </Button>
  </div>
</div>
```

## Rules

- **Nav is a floating panel.** Not edge-stretched, has margin from viewport.
- **Active item is visually clear.** Background tint + font weight change.
- **Icons always have labels.** No icon-only navigation.
- **Mobile uses a sheet.** Not a bottom nav bar.
- **Max 6 nav items.** If you need more, use groups or a dropdown.
- **Sticky positioning.** Nav stays visible on scroll (`sticky top-6`).

## Common Mistakes

| Mistake                   | Fix                                |
| ------------------------- | ---------------------------------- |
| Edge-to-edge sidebar      | Floating panel with margin         |
| Icon-only nav items       | Always include text labels         |
| No active state           | Add background tint + font-medium  |
| Bottom nav on mobile      | Use a sheet (slide-from-left)      |
| Nav stretches full height | `h-fit` with sticky positioning    |
| No mobile hamburger       | Add Sheet trigger on small screens |
