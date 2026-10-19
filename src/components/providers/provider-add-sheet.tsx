"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Key, Loader2, Search, Shield } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { ProviderCatalogView } from "@/lib/providers/catalog";
import { PI_DEFAULT_CONTEXT_WINDOW, PI_DEFAULT_MAX_OUTPUT_TOKENS } from "@/lib/providers/limits";
import type { ProviderAuthType } from "@/lib/providers/login";

/**
 * Picking a provider to connect.
 *
 * Pi's catalog is longer than any list worth scrolling past, so the page shows
 * only what is linked and everything else is searched for here. Linked providers
 * still appear, at the top and inert, so searching for one answers "already
 * connected" instead of nothing at all.
 */

/** The OpenAI-compatible endpoint form, as the strings its inputs hold. */
export interface EndpointDraft {
  apiKey: string;
  label: string;
  baseUrl: string;
  contextWindow: string;
  maxOutputTokens: string;
}

/** The scope's existing endpoint, or blanks when it has none yet. */
export interface EndpointDefaults extends EndpointDraft {
  exists: boolean;
}

export const EMPTY_ENDPOINT_DEFAULTS: EndpointDefaults = {
  exists: false,
  apiKey: "",
  label: "",
  baseUrl: "",
  contextWindow: "",
  maxOutputTokens: "",
};

/** Which face the sheet opens on. */
export type AddSheetMode = "browse" | "endpoint";

export interface ProviderAddSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every provider this scope can see, linked or not. */
  providers: ProviderCatalogView[];
  loading: boolean;
  mode: AddSheetMode;
  /** What the endpoint form starts from. */
  endpoint: EndpointDefaults;
  saving: boolean;
  onConnect: (entry: ProviderCatalogView, authType: ProviderAuthType) => void;
  onSaveEndpoint: (draft: EndpointDraft) => void;
  onSaveLimits: (draft: EndpointDraft) => void;
}

export function ProviderAddSheet({
  open,
  onOpenChange,
  providers,
  loading,
  mode,
  endpoint,
  saving,
  onConnect,
  onSaveEndpoint,
  onSaveLimits,
}: ProviderAddSheetProps) {
  const [step, setStep] = useState<AddSheetMode>(mode);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<EndpointDraft>(toDraft(endpoint));

  // Each open starts from the requested step, with a clean search and form.
  useEffect(() => {
    if (!open) return;
    setStep(mode);
    setSearch("");
    setDraft(toDraft(endpoint));
  }, [open, mode, endpoint]);

  const term = search.trim().toLowerCase();
  const matches = (entry: ProviderCatalogView) =>
    !term || entry.name.toLowerCase().includes(term) || entry.id.toLowerCase().includes(term);

  const linked = providers.filter((entry) => entry.configured).filter(matches);
  const unlinked = providers.filter((entry) => !entry.configured).filter(matches);
  const noMatches = !loading && linked.length === 0 && unlinked.length === 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none">
        <div className="flex min-h-0 flex-1 flex-col">
          <SheetHeader className="shrink-0 border-b px-4 pt-4 pb-3">
            <SheetTitle className="flex items-center gap-2 text-base leading-tight font-semibold">
              {step === "endpoint" && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="-ml-1.5 shrink-0"
                  onClick={() => setStep("browse")}
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span className="sr-only">Back to providers</span>
                </Button>
              )}
              {step === "endpoint" ? "OpenAI-compatible endpoint" : "Add a provider"}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground text-xs">
              {step === "endpoint"
                ? "Any server that speaks the OpenAI API — a local llama.cpp, Ollama or vLLM instance."
                : "Linked providers are listed first. Search for the one you want to connect."}
            </SheetDescription>
          </SheetHeader>

          {step === "browse" ? (
            <>
              <div className="shrink-0 px-4 pt-3">
                <div className="relative">
                  <Search className="text-muted-foreground absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search providers…"
                    aria-label="Search providers"
                    className="h-8 pl-9 text-xs"
                    autoFocus
                  />
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto pb-3">
                {loading && (
                  <div className="flex justify-center py-8">
                    <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                  </div>
                )}

                {noMatches && (
                  <p className="text-muted-foreground px-4 py-8 text-center text-sm">
                    No provider matches.
                  </p>
                )}

                {linked.length > 0 && (
                  <section>
                    <div className="console-label px-4 pt-3 pb-1">Linked — {linked.length}</div>
                    {linked.map((entry, index) => (
                      <div key={entry.id}>
                        <CandidateRow entry={entry} />
                        {index < linked.length - 1 && <Separator className="px-4" />}
                      </div>
                    ))}
                  </section>
                )}

                {unlinked.length > 0 && (
                  <section>
                    <div className="console-label px-4 pt-4 pb-1">
                      Available — {unlinked.length}
                    </div>
                    {unlinked.map((entry, index) => (
                      <div key={entry.id}>
                        <CandidateRow
                          entry={entry}
                          onConnect={onConnect}
                          onConfigureEndpoint={() => setStep("endpoint")}
                        />
                        {index < unlinked.length - 1 && <Separator className="px-4" />}
                      </div>
                    ))}
                  </section>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Base URL</Label>
                  <Input
                    placeholder="http://localhost:11434/v1"
                    value={draft.baseUrl}
                    onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">API key</Label>
                  <Input
                    type="password"
                    placeholder="optional for a local server"
                    value={draft.apiKey}
                    onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Label</Label>
                  <Input
                    placeholder="optional"
                    value={draft.label}
                    onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Context window</Label>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      placeholder={String(PI_DEFAULT_CONTEXT_WINDOW)}
                      value={draft.contextWindow}
                      onChange={(event) =>
                        setDraft({ ...draft, contextWindow: event.target.value })
                      }
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Max output tokens</Label>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      placeholder={String(PI_DEFAULT_MAX_OUTPUT_TOKENS)}
                      value={draft.maxOutputTokens}
                      onChange={(event) =>
                        setDraft({ ...draft, maxOutputTokens: event.target.value })
                      }
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                </div>
                <p className="text-muted-foreground text-[11px]">
                  Limits are what Pi sends as the request&apos;s token budget for the models this
                  endpoint serves. Leave them empty to use Pi&apos;s defaults (
                  {PI_DEFAULT_CONTEXT_WINDOW.toLocaleString()} context /{" "}
                  {PI_DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString()} output); a larger cap than the
                  endpoint allows is rejected by the provider.
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-3">
                <Button
                  size="sm"
                  className="h-8"
                  onClick={() => onSaveEndpoint(draft)}
                  disabled={saving || !draft.baseUrl}
                >
                  {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  Save
                </Button>
                {endpoint.exists && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    onClick={() => onSaveLimits(draft)}
                    disabled={saving}
                  >
                    Limits only
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function toDraft(endpoint: EndpointDefaults): EndpointDraft {
  const { apiKey, label, baseUrl, contextWindow, maxOutputTokens } = endpoint;
  return { apiKey, label, baseUrl, contextWindow, maxOutputTokens };
}

/** How a provider's sign-in button reads. */
function methodLabel(entry: ProviderCatalogView, method: ProviderCatalogView["methods"][number]) {
  if (method.type === "oauth") return "Sign in";
  return entry.methods.length > 1 ? "API key" : "Connect";
}

interface CandidateRowProps {
  entry: ProviderCatalogView;
  onConnect?: (entry: ProviderCatalogView, authType: ProviderAuthType) => void;
  onConfigureEndpoint?: () => void;
}

function CandidateRow({ entry, onConnect, onConfigureEndpoint }: CandidateRowProps) {
  return (
    <div className="hover:bg-accent/60 flex items-center gap-3 px-4 py-2.5 transition-colors duration-150">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          {entry.custom && (
            <Badge variant="secondary" className="shrink-0 rounded-full px-1.5 text-[10px]">
              custom
            </Badge>
          )}
        </div>
        <span className="text-muted-foreground block truncate text-xs">
          {entry.modelCount} {entry.modelCount === 1 ? "model" : "models"}
          {entry.baseUrl ? ` — ${entry.baseUrl}` : ""}
        </span>
      </div>

      {entry.configured ? (
        <Badge variant="secondary" className="shrink-0 rounded-full px-1.5 text-[10px]">
          linked
        </Badge>
      ) : (
        <div className="flex shrink-0 items-center gap-1.5">
          {entry.custom ? (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 text-xs"
              onClick={onConfigureEndpoint}
            >
              Configure
            </Button>
          ) : entry.methods.length === 0 ? (
            <span
              className="text-muted-foreground shrink-0 text-[11px]"
              title="Pi reads this provider's credentials from the environment"
            >
              env
            </span>
          ) : (
            entry.methods.map((method) => (
              <Button
                key={method.type}
                variant="secondary"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onConnect?.(entry, method.type)}
              >
                {method.type === "oauth" ? (
                  <Shield className="mr-1 h-3 w-3" />
                ) : (
                  <Key className="mr-1 h-3 w-3" />
                )}
                {methodLabel(entry, method)}
              </Button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
