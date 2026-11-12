"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { MoreVertical, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Page, PageAction, PageActions } from "@/components/layout/page";
import { deleteJson, fetchJson } from "@/lib/http";
import type { SsoProviderStatus } from "@/lib/auth/sso-config";
import { SsoProviderSheet } from "./sso-provider-sheet";

/** The host an admin recognises a provider by, or the whole issuer when it will not parse. */
function issuerLabel(issuer: string): string {
  if (!issuer) return "No issuer yet";
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

function domainsLabel(provider: SsoProviderStatus): string {
  const count = provider.allowedDomains.length;
  if (count === 0) return "existing accounts only";
  return count === 1 ? "1 domain" : `${count} domains`;
}

/**
 * The instance's identity providers.
 *
 * A company can have more than one directory, so this is a list: each provider
 * has its own issuer, its own callback and its own allowed domains, and the
 * login page shows a button for every one that is ready.
 */
export function SsoSection() {
  const [providers, setProviders] = useState<SsoProviderStatus[] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<SsoProviderStatus | null>(null);
  const [removing, setRemoving] = useState<SsoProviderStatus | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchJson<{ providers: SsoProviderStatus[] }>("/api/admin/sso")
      .then((data) => setProviders(data.providers))
      .catch((err) => console.error("Failed to load the single sign-on providers:", err));
  }, []);

  const add = useCallback(() => {
    setEditing(null);
    setSheetOpen(true);
  }, []);

  const edit = useCallback((provider: SsoProviderStatus) => {
    setEditing(provider);
    setSheetOpen(true);
  }, []);

  const saved = useCallback((provider: SsoProviderStatus, created: boolean) => {
    setProviders((current) => {
      const list = current ?? [];
      return list.some((existing) => existing.id === provider.id)
        ? list.map((existing) => (existing.id === provider.id ? provider : existing))
        : [...list, provider];
    });
    // A new provider stays open: its redirect URI is what the admin needs next.
    if (created) setEditing(provider);
  }, []);

  const remove = useCallback(async () => {
    if (!removing) return;

    setDeleting(true);
    try {
      const data = await deleteJson<{ providers: SsoProviderStatus[] }>(
        `/api/admin/sso/${removing.id}`,
      );
      setProviders(data.providers);
      toast.success("Provider removed");
      setRemoving(null);
    } catch (err) {
      console.error("Failed to remove the single sign-on provider:", err);
      toast.error("Could not remove the provider");
    } finally {
      setDeleting(false);
    }
  }, [removing]);

  const loading = providers === null;

  return (
    <Page className="gap-0">
      <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
        <PageActions
          leading={
            <span className="console-label text-muted-foreground hidden shrink-0 sm:block">
              {loading
                ? ""
                : providers.length === 1
                  ? "1 provider"
                  : `${providers.length} providers`}
            </span>
          }
        >
          <PageAction icon={Plus} label="Add provider" onClick={add} />
        </PageActions>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <span className="text-muted-foreground console-label">Loading…</span>
            </div>
          ) : providers.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
              <ShieldCheck className="text-muted-foreground/50 mb-3 h-8 w-8" />
              <p className="text-sm font-medium">No identity providers</p>
              <p className="text-muted-foreground mt-1 max-w-sm text-xs">
                Add the company directory people sign in with. The login page shows a button for
                every provider that is ready.
              </p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={add}>
                Add provider
              </Button>
            </div>
          ) : (
            providers.map((provider, index) => (
              <Fragment key={provider.id}>
                <div
                  className="hover:bg-accent/60 group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-150"
                  onClick={() => edit(provider)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{provider.name}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {issuerLabel(provider.issuer)}
                      <span className="text-muted-foreground/70"> · {domainsLabel(provider)}</span>
                    </p>
                  </div>

                  <Badge
                    variant={provider.configured ? "secondary" : "outline"}
                    className="shrink-0 rounded-full"
                  >
                    {provider.configured ? "Ready" : "Not set up"}
                  </Badge>

                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={(triggerProps) => {
                        const { onClick, ...rest } = triggerProps;
                        return (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0"
                            {...rest}
                            onClick={(event) => {
                              event.stopPropagation();
                              onClick?.(event);
                            }}
                          >
                            <MoreVertical />
                            <span className="sr-only">Actions for {provider.name}</span>
                          </Button>
                        );
                      }}
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={(event) => {
                          event.stopPropagation();
                          edit(provider);
                        }}
                      >
                        <Pencil />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          setRemoving(provider);
                        }}
                      >
                        <Trash2 />
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {index < providers.length - 1 && <Separator className="border-border/30 px-4" />}
              </Fragment>
            ))
          )}
        </div>
      </GlassPanel>

      <SsoProviderSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        provider={editing}
        onSaved={saved}
      />

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The login page stops offering this provider, and accounts that only exist there cannot
              sign in until it is added again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={deleting} onClick={() => void remove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
