/**
 * The pages on github.com that belong to a GitHub App.
 *
 * A GitHub App has no installation page of its own: `https://github.com/apps/
 * <slug>/installations/` does not exist. GitHub keeps the repository choice of
 * an existing installation under the account's settings, and only starts a new
 * one under the app's page.
 */

/** Where GitHub starts a fresh installation of the app. */
export function appInstallUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

/** Where GitHub lets the account choose the repositories of one installation. */
export function installationSettingsUrl(installation: {
  installationId: string;
  accountLogin: string;
  accountType: string;
}): string {
  const id = encodeURIComponent(installation.installationId);
  return installation.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

/** What one installation has to know for its settings link. */
export interface InstallationLinkSource {
  installationId: string;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

/**
 * Where to send an account that wants to change which repositories the app
 * reaches: the settings of its installation, or the install page when there is
 * none yet. A suspended installation cannot be configured, so it is skipped.
 */
export function manageInstallationsUrl(
  slug: string,
  installations: readonly InstallationLinkSource[],
): string {
  const installation = installations.find((entry) => !entry.suspended) ?? installations[0];
  return installation ? installationSettingsUrl(installation) : appInstallUrl(slug);
}
