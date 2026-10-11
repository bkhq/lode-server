import { registerBackupContribution } from "@/modules/backup/registry";
import { registerTokenScope } from "@/shared/lib/token-scopes";
import { registerAuthProvider } from "@/shared/middleware/auth-registry";
import { accountBackupContribution } from "./account.backup";
import { oauthSessionAuthProvider } from "./auth/auth.service";
import { apiTokenAuthProvider } from "./tokens";

export { accountRoutes } from "./account.routes";

registerBackupContribution(accountBackupContribution);
registerAuthProvider(oauthSessionAuthProvider);
// After the session provider: a request carrying both a session cookie and a
// token is the browser's, and keeps the session's unrestricted access.
registerAuthProvider(apiTokenAuthProvider);

registerTokenScope({
  name: "account:read",
  description: "Read your own profile and group memberships",
  routes: [{ method: "GET", path: "/account/me" }, { method: "GET", path: "/account/me/groups" }],
});
