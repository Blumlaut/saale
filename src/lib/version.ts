/**
 * The release this build came from, as the console footer shows it.
 *
 * An image build passes it in; a checkout falls back to `package.json` through
 * `next.config.ts`, and a build with neither says `dev`.
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
