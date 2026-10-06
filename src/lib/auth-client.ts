import { createAuthClient } from "better-auth/react";
import { adminClient, usernameClient } from "better-auth/client/plugins";
import { twoFactorClient } from "better-auth/plugins";

export const authClient = createAuthClient({
  // `displayUsername: false` mirrors the server plugin — see src/auth.ts.
  plugins: [adminClient(), twoFactorClient(), usernameClient({ displayUsername: false })],
});
