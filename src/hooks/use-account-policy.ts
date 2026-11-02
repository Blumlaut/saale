"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/http";
import { DEFAULT_ACCOUNT_POLICY, type AccountPolicy } from "@/lib/auth/password";

/** What this instance asks of an account, before anyone configured it. */
const BUILT_IN_POLICY: AccountPolicy = DEFAULT_ACCOUNT_POLICY;

/**
 * The instance's account policy, with the built-in bounds until it arrives.
 * The server checks the same policy on every request that sets a password.
 */
export function useAccountPolicy(): AccountPolicy {
  const [policy, setPolicy] = useState<AccountPolicy>(BUILT_IN_POLICY);

  useEffect(() => {
    fetchJson<AccountPolicy>("/api/account-policy")
      .then(setPolicy)
      .catch((err) => console.error("Failed to load the account policy:", err));
  }, []);

  return policy;
}
