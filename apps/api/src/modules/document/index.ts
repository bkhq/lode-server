import { registerBackupContribution } from "@/modules/backup/registry";
import { registerTokenScope } from "@/shared/lib/token-scopes";
import { documentBackupContribution } from "./document.backup";

// Side-effect import: registers the document resource with the policy
// framework. The `documentAccess` client is re-exported below so other
// modules can compose against the same vocabulary.
export { documentAccess } from "./document.permission";
export { documentRoutes } from "./document.routes";

registerBackupContribution(documentBackupContribution);

// Personal API tokens reach these routes only through these scopes; object
// access is still checked by policy, as the token's user.
registerTokenScope({
  name: "documents:read",
  description: "Read documents, their comments and attachments",
  routes: [
    { method: "GET", path: "/documents" },
    { method: "GET", path: "/documents/*" },
  ],
});
registerTokenScope({
  name: "documents:write",
  description: "Create, change and delete documents, their comments and attachments",
  routes: [
    { method: "POST", path: "/documents" },
    { method: "POST", path: "/documents/*" },
    { method: "PATCH", path: "/documents/*" },
    { method: "DELETE", path: "/documents/*" },
  ],
});
