import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { twoFactorClient } from "better-auth/plugins";

export const authClient = createAuthClient({
  plugins: [adminClient(), twoFactorClient()],
});
