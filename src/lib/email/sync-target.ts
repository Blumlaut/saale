/**
 * Resolve the sync endpoint for the mail tab's sync button.
 * When a specific account is selected, sync only that account; otherwise sync all.
 */
export function emailSyncEndpoint(accountId: string | null | undefined): string {
  return accountId ? `/api/email/accounts/${accountId}/sync` : "/api/email/sync";
}
