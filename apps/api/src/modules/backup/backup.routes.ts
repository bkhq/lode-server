import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { backupExportRoutes } from "./export.routes";
import { backupImportRoutes } from "./restore.routes";

export function backupRoutes() {
  const router = new Hono<AppEnv>();
  router.route("/", backupExportRoutes());
  router.route("/", backupImportRoutes());
  return router;
}
