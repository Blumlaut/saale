import { cache } from "react";
import { readAdminSettings } from "@/lib/settings/update";
import { normalizeWorkspaceName } from "./workspace-name";

/**
 * The name this instance shows, read once per request.
 *
 * A layout and its metadata both ask for it, so the read is memoized rather
 * than repeated.
 */
export const getWorkspaceName = cache(async (): Promise<string> => {
  const settings = await readAdminSettings();
  return normalizeWorkspaceName(settings?.workspaceName);
});
