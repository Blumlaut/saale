import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { IntegrationManifest } from "@/lib/integrations/types";

/** What a box shows about its integration. A manifest carries it, and so does a sign-in that is not one. */
export type IntegrationBoxInfo = Pick<
  IntegrationManifest,
  "name" | "description" | "icon" | "color"
>;

/**
 * Shared shell for the integration boxes on the Integrations tab.
 *
 * Every box answers the same three questions. what is this, is it connected,
 * and what can I do about it (a status line or a connect button). so the tab
 * reads as a fixed set of capabilities instead of a list to grow.
 */
export function IntegrationBox({
  manifest,
  connected,
  badges,
  children,
}: {
  manifest: IntegrationBoxInfo;
  connected: boolean;
  /** Optional badges next to the name (e.g. the linked @username). */
  badges?: ReactNode;
  children: ReactNode;
}) {
  const Icon = manifest.icon;

  return (
    <div className="bg-muted flex min-w-0 flex-col rounded-2xl border-0 p-5">
      <div className="flex items-start gap-3">
        <div className="bg-muted shrink-0 rounded-xl p-2.5">
          <Icon className={`h-5 w-5 ${manifest.color}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium">{manifest.name}</h4>
            {badges}
            <Badge variant={connected ? "secondary" : "outline"} className="rounded-full">
              {connected ? "Connected" : "Not connected"}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">{manifest.description}</p>
        </div>
      </div>
      <div className="mt-4 flex-1">{children}</div>
    </div>
  );
}
