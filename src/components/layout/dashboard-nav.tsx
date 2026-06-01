"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  MessageSquare,
  Mail,
  ListTodo,
  Settings,
  ChevronRight,
  Moon,
  Sun,
  Search,
  X,
  Loader2,
} from "lucide-react";
import { useTheme } from "next-themes";

const navItems = [
  { href: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { href: "/dashboard/mail", label: "Mail", icon: Mail },
  { href: "/dashboard/tasks", label: "Tasks", icon: ListTodo },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

interface SearchResult {
  type: "chat" | "email";
  id: string;
  title: string;
  snippet: string;
  date: string;
}

export function DashboardNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  // Close search on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
      }
      // Cmd/Ctrl + K to open search
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen]);

  // Listen for focus-search event from keyboard shortcuts
  useEffect(() => {
    const handleFocusSearch = () => {
      setSearchOpen(true);
    };
    window.addEventListener("focus-search", handleFocusSearch);
    return () => window.removeEventListener("focus-search", handleFocusSearch);
  }, []);

  // Close search on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Search handler
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchLoading(false);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&limit=10`);
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data.results);
        }
      } catch {
        // Ignore
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleResultClick = (result: SearchResult) => {
    setSearchOpen(false);
    setSearchQuery("");
    if (result.type === "chat") {
      router.push(`/dashboard/chat/${result.id}`);
    } else if (result.type === "email") {
      router.push("/dashboard/mail");
    }
  };

  return (
    <nav className="sticky top-6 h-fit w-56 shrink-0">
      <GlassPanel className="shadow-md">
        <GlassPanelContent className="p-3">
          {/* Brand */}
          <Link href="/dashboard" className="mb-1 flex items-center gap-2 px-3 py-2">
            <ChevronRight className="text-primary h-5 w-5" />
            <span className="text-lg font-bold tracking-tight">Saale</span>
          </Link>

          <Separator className="my-2" />

          {/* Search */}
          <div className="px-1 pb-2" ref={searchRef}>
            <div className="relative">
              <Button
                variant="ghost"
                className="text-muted-foreground h-8 w-full justify-start gap-2 rounded-lg px-2"
                onClick={() => setSearchOpen((prev) => !prev)}
              >
                <Search className="h-3.5 w-3.5" />
                <span className="flex-1 text-left text-xs">Search...</span>
                <kbd className="text-muted-foreground/50 bg-muted/50 rounded border px-1.5 py-0.5 text-[10px]">
                  ⌘K
                </kbd>
              </Button>

              {/* Search dropdown */}
              {searchOpen && (
                <div className="bg-background/95 absolute top-full left-0 z-50 mt-1 w-72 rounded-xl border shadow-lg backdrop-blur-xl">
                  <div className="flex items-center gap-2 border-b px-3 py-2">
                    <Search className="text-muted-foreground h-4 w-4" />
                    <Input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search chats, emails..."
                      className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
                      autoFocus
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => {
                        setSearchOpen(false);
                        setSearchQuery("");
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>

                  <div className="max-h-64 overflow-y-auto p-1">
                    {searchLoading ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                      </div>
                    ) : !searchQuery ? null : searchResults.length === 0 ? (
                      <div className="text-muted-foreground py-4 text-center text-sm">
                        No results found
                      </div>
                    ) : (
                      searchResults.map((result) => (
                        <button
                          key={result.id}
                          onClick={() => handleResultClick(result)}
                          className="hover:bg-muted/50 flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors"
                        >
                          <Badge
                            variant="secondary"
                            className={cn(
                              "shrink-0 rounded-full px-1.5 py-0 text-[10px]",
                              result.type === "chat"
                                ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                                : "bg-green-500/10 text-green-600 dark:text-green-400",
                            )}
                          >
                            {result.type}
                          </Badge>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{result.title}</div>
                            <div className="text-muted-foreground truncate text-xs">
                              {result.snippet}
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Nav Items */}
          <div className="space-y-0.5">
            {navItems.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
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

      {/* Theme toggle + version */}
      <div className="mt-4 flex items-center justify-between px-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-lg"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label="Toggle theme"
        >
          <Sun className="h-4 w-4 dark:hidden" />
          <Moon className="hidden h-4 w-4 dark:block" />
        </Button>
        <p className="text-muted-foreground text-xs">v0.1.0</p>
      </div>
    </nav>
  );
}
