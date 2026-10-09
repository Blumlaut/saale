import type { ComponentType } from "react";

/** Base metadata for any integration */
export interface IntegrationManifest {
  /** Unique identifier, matches the API route segment */
  id: IntegrationId;
  /** Display name */
  name: string;
  /** Short description shown on the integration box */
  description: string;
  /** Icon component */
  icon: ComponentType<{ className?: string }>;
  /** Tailwind color class for the icon */
  color: string;
  /** API base path (e.g. "/api/integrations/telegram") */
  apiBase: string;
}

/** Union of registered integration IDs */
export type IntegrationId = "telegram" | "github";
