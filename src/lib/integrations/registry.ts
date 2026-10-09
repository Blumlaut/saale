import type { IntegrationManifest } from "./types";
import { MessageCircle, GitFork } from "lucide-react";

/**
 * Integration registry — the single source of truth for available integrations.
 *
 * To add a new integration:
 * 1. Add an entry here with metadata and API path
 * 2. Create API routes at `src/app/api/integrations/{id}/route.ts`
 * 3. Create a card component at `src/components/integrations/{id}-card.tsx`
 * 4. Import and render the card in `integrations-tab.tsx`
 *
 * The tab component reads this registry to render the add dialog, empty state,
 * and available integrations list — no hardcoded conditionals needed.
 */
export const INTEGRATIONS: IntegrationManifest[] = [
  {
    id: "telegram",
    name: "Telegram",
    description: "Chat with Saale on Telegram — link your account to the shared bot",
    icon: MessageCircle,
    color: "text-sky-500",
    apiBase: "/api/integrations/telegram",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Let agents manage repos, PRs, and issues via gh CLI",
    icon: GitFork,
    color: "text-gray-500",
    apiBase: "/api/integrations/github",
  },
];

/** Lookup by ID */
export const INTEGRATION_MAP = new Map<string, IntegrationManifest>(
  INTEGRATIONS.map((i) => [i.id, i]),
);

/**
 * Find a manifest by ID.
 */
export function getIntegration(id: string): IntegrationManifest | undefined {
  return INTEGRATION_MAP.get(id);
}
