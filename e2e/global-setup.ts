import { mkdir } from "node:fs/promises";
import path from "node:path";

import { request, type FullConfig } from "@playwright/test";

import { SESSION_FILE } from "./env";
import {
  ensureLocalCalendarAccount,
  ensureUser,
  grantAdminRole,
  signIn,
  seedStressData,
} from "./utils";

/**
 * The work every suite needs, done once per run.
 *
 * It used to be a `beforeAll` in each spec file: fourteen logins, fourteen
 * admin grants, fourteen copies of the same seed requests. Here it is one
 * sign-in, and the storage state it leaves behind is what every context in
 * `playwright.config.ts` starts from.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("e2e: global setup needs a baseURL");

  const api = await request.newContext({ baseURL });
  try {
    await ensureUser(api);
    // Before signing in, so the session the suite reuses carries the role.
    await grantAdminRole();
    await signIn(api);
    await seedStressData(api);
    await ensureLocalCalendarAccount(api);

    await mkdir(path.dirname(SESSION_FILE), { recursive: true });
    await api.storageState({ path: SESSION_FILE });
  } finally {
    await api.dispose();
  }
}
