"use client";

import { ProviderConnections } from "@/components/providers/provider-connections";

interface ProviderManagementProps {
  onModelsChanged: () => void;
}

/**
 * The user's providers, configured against their own credential scope. The list,
 * the sign-in flow and the OpenAI-compatible endpoint form are shared with the
 * admin's global view.
 */
export function ProviderManagement({ onModelsChanged }: ProviderManagementProps) {
  return <ProviderConnections scope="user" onChanged={onModelsChanged} />;
}
