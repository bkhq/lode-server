import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { authRoutes } from "./auth";
import { groupRoutes } from "./groups";
import { tokenRoutes } from "./tokens";
import { userRoutes } from "./users";

export function accountRoutes() {
  const router = new Hono<AppEnv>();
  router.route("/", authRoutes());
  router.route("/", userRoutes());
  router.route("/", groupRoutes());
  router.route("/", tokenRoutes());
  return router;
}
