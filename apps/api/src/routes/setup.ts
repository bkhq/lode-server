// Routes mounted only while the system is locked: encryption init / unlock.
// Not mounted on the unlocked app — keeps the init/unlock attack surface minimal.
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { encryptionPublicRoutes } from "@/modules/encryption";

export function setupRoutes() {
  const app = new Hono<AppEnv>();

  app.route("/", encryptionPublicRoutes());

  return app;
}
