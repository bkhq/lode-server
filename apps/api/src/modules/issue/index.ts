import { registerBackupContribution } from "@/modules/backup/registry";
import { registerTokenScope } from "@/shared/lib/token-scopes";
import { issueBackupContribution } from "./issue.backup";

// Side-effect import: registers the issue resource (and its route
// bindings) with the policy framework.
export { issueAccess } from "./issue.permission";
export { issueRoutes } from "./issue.routes";

registerBackupContribution(issueBackupContribution);

// Personal API tokens reach these routes only through these scopes; object
// access is still checked by policy, as the token's user.
registerTokenScope({
  name: "issues:read",
  description: "Read issues, their comments and attachments",
  routes: [
    { method: "GET", path: "/issues" },
    { method: "GET", path: "/issues/*" },
  ],
});
registerTokenScope({
  name: "issues:write",
  description: "Create, change and delete issues, their comments and attachments",
  routes: [
    { method: "POST", path: "/issues" },
    { method: "POST", path: "/issues/*" },
    { method: "PATCH", path: "/issues/*" },
    { method: "DELETE", path: "/issues/*" },
  ],
});
