import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { encryptionStatusRoute } from "@/modules/encryption";
import { systemRoutes } from "@/modules/system";

export function publicRoutes() {
  const app = new Hono<AppEnv>();

  app.route("/", encryptionStatusRoute());
  app.route("/", systemRoutes());

  return app;
}
