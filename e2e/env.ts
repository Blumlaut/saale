import { config } from "dotenv";

config({ quiet: true });

/**
 * Where the suite points.
 *
 * `scripts/dev.sh` records this checkout's port in `.env`, so a checkout whose
 * dev server is on 3635 never has to say so. `BASE_URL` wins when the app lives
 * somewhere else (a preview, a deployed instance).
 */
export const PORT = Number(process.env.E2E_PORT ?? process.env.PORT ?? 3630);

export const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

/** Signed-in storage state that `global-setup.ts` writes once per run. */
export const SESSION_FILE = ".playwright/e2e-session.json";

/** Screenshots and other throwaway output from `scripts/shot.ts`. */
export const SHOT_DIR = ".dev/shots";
