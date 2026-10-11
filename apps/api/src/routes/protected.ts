import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { accountRoutes } from "@/modules/account";
import { auditRoutes } from "@/modules/audit";
import { backupRoutes } from "@/modules/backup";
import { cronRoutes } from "@/modules/cron";
import { encryptionProtectedRoutes } from "@/modules/encryption";
import { fileRoutes } from "@/modules/file";
import { policyRoutes } from "@/modules/policy";
import { registryRoutes } from "@/modules/registry";
import { settingsRoutes } from "@/modules/settings";
// requireUnlocked is defense-in-depth: protectedRoutes is only mounted by
// buildFullApp (after the DB has been decrypted), but the middleware also
// catches the case where the system gets re-locked at runtime (e.g. master
// key rotation) before this app instance is rebuilt.
import { requireUnlocked } from "@/shared/middleware/encryption";
// Side-effect import: the `item` module ships no HTTP routes; it registers
// its backup contribution and the `item_attachment` file permission hook at
// load time.
import "@/modules/item";

export function protectedRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", requireUnlocked);

  app.route("/", accountRoutes());
  app.route("/", policyRoutes());
  app.route("/", settingsRoutes());
  app.route("/", auditRoutes());
  app.route("/", encryptionProtectedRoutes());
  app.route("/", backupRoutes());
  app.route("/", cronRoutes());
  app.route("/", fileRoutes());
  app.route("/", registryRoutes());

  return app;
}
