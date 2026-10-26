"use client";

import { useMemo, useState } from "react";
import { PageActions, PageAction } from "@/components/layout/page";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Fragment } from "react";
import { MoreVertical, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { cn, ROW_ACTION } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format";
import type { Contact } from "@/types/shared";

interface ContactListProps {
  contacts: Contact[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (contact: Contact) => void;
  onDelete: (contact: Contact) => void;
}

export function ContactList({ contacts, loading, onAdd, onEdit, onDelete }: ContactListProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.company?.toLowerCase().includes(q) ?? false),
    );
  }, [contacts, query]);

  return (
    <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
      <PageActions
        leading={
          <>
            <div className="relative min-w-0 flex-1 md:max-w-xs">
              <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search contacts"
                aria-label="Search contacts"
                className="liquid-glass-inner h-8 rounded-full border-0 bg-transparent pl-8 shadow-none"
              />
            </div>
            <span className="text-muted-foreground console-label hidden shrink-0 sm:block">
              {contacts.length} total
            </span>
          </>
        }
      >
        <PageAction icon={Plus} label="New Contact" onClick={onAdd} />
      </PageActions>

      {/* List. the only scroll region */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-muted-foreground console-label">Loading…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
            <Users className="text-muted-foreground/50 mb-3 h-8 w-8" />
            {contacts.length === 0 ? (
              <>
                <p className="text-sm font-medium">No contacts yet</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Contacts are added automatically as you send mail. or add one manually.
                </p>
                <Button variant="secondary" size="sm" className="mt-4" onClick={onAdd}>
                  New Contact
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">No matches</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  No contacts match “{query.trim()}”.
                </p>
              </>
            )}
          </div>
        ) : (
          filtered.map((contact, i) => (
            <Fragment key={contact.id}>
              <div
                className={cn(
                  "group hover:bg-accent/60 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors duration-150 md:px-4",
                )}
                onClick={() => onEdit(contact)}
              >
                <Avatar className="h-9 w-9 shrink-0 rounded-full">
                  <AvatarFallback className="liquid-glass-pill text-xs font-medium">
                    {contact.name.trim().charAt(0).toUpperCase() || "?"}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{contact.name}</p>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {contact.email}
                    {contact.company ? (
                      <span className="text-muted-foreground/70"> · {contact.company}</span>
                    ) : null}
                  </p>
                </div>
                {contact.lastSentAt && (
                  <span className="console-label text-muted-foreground hidden shrink-0 md:block">
                    sent {formatRelativeDate(contact.lastSentAt)}
                  </span>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={(triggerProps) => {
                      const { onClick, ...rest } = triggerProps;
                      return (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className={cn("shrink-0", ROW_ACTION)}
                          {...rest}
                          onClick={(e) => {
                            e.stopPropagation();
                            onClick?.(e);
                          }}
                        >
                          <MoreVertical />
                          <span className="sr-only">Actions for {contact.name}</span>
                        </Button>
                      );
                    }}
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(contact);
                      }}
                    >
                      <Pencil />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(contact);
                      }}
                    >
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {i < filtered.length - 1 && <Separator className="border-border/30 px-4" />}
            </Fragment>
          ))
        )}
      </div>
    </GlassPanel>
  );
}
