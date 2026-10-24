import type { LodePrepareWatcher } from "./lode";
import process from "node:process";
import { sql } from "drizzle-orm";
import { bootstrap } from "./app";
import { BUILD_INFO } from "./build-info";
import { dispatchCliSubcommand } from "./cli";
import { captureLodeConfigBaseline, reportLodeServing, startLodePrepareWatcher } from "./lode";
import { stopAuditRetentionSweep } from "./modules/audit";
import { stopCron } from "./modules/cron";
import { stopFileGcSweep } from "./modules/file";
import { acquirePidLock, releasePidLock } from "./pid-lock";
import { attemptSealedUnlock } from "./sealed-unlock";

(async () => {
  const subcommandExit = await dispatchCliSubcommand(process.argv);
  if (subcommandExit !== null) {
    process.exit(subcommandExit);
  }
  const { fetch, config, logger, db, closeDb } = await bootstrap();
  logger.info({ ...BUILD_INFO }, "build info");

  // Bind the port before acquiring the PID lock so a concurrent boot loses
  // the EADDRINUSE race before reaching the PID-alive check (each instance
  // sees its own PID and would otherwise both proceed past the lock).
  const server = Bun.serve({
    port: config.PORT,
    hostname: config.HOST,
    // Padding above the per-file ceiling for multipart framing overhead.
    maxRequestBodySize: config.MAX_UPLOAD_BYTES + 64 * 1024,
    fetch: (req, srv) => fetch(req, {
      IP: srv.requestIP(req),
    }),
  });

  async function safe(name: string, fn: () => unknown, silent = false): Promise<void> {
    try {
      await fn();
    }
    catch (err) {
      if (!silent)
        logger.error({ err }, `${name} failed`);
    }
  }

  let shuttingDown = false;
  let lodePrepare: LodePrepareWatcher | undefined;

  // Unified teardown for signals, pid-lock failure, and fatal exceptions.
  // fatal=true: immediate stop, silent per-step errors (logger may be gone),
  // exit 1. fatal=false: bounded drain, log per-step errors, exit 0.
  // Logger is flushed both before and after closeDb so a hung closeDb can't
  // strand prior logs, and closeDb's own error still lands on disk.
  async function closeServices(opts: { reason: string; fatal: boolean; err?: unknown }): Promise<void> {
    if (shuttingDown) {
      logger.debug({ reason: opts.reason }, "shutdown already in progress");
      return;
    }
    shuttingDown = true;

    if (opts.fatal)
      logger.fatal({ err: opts.err }, opts.reason);
    else
      logger.info({ signal: opts.reason }, "shutting down");

    const silent = opts.fatal;
    // fatal: immediate. graceful: bounded 25 s drain (orchestrator grace ~30 s)
    // then hard-stop in case the soft stop didn't finish.
    const stopServer = opts.fatal
      ? () => server.stop(true)
      : async () => {
        await Promise.race([
          server.stop(true),
          new Promise<void>(resolve => setTimeout(resolve, 25_000).unref?.()),
        ]);
        try {
          server.stop(false);
        }
        catch {}
      };

    await safe("server.stop", stopServer, silent);
    await safe("stopLodePrepareWatcher", () => lodePrepare?.stop(), silent);
    await safe("stopAuditRetentionSweep", stopAuditRetentionSweep, silent);
    await safe("stopFileGcSweep", stopFileGcSweep, silent);
    await safe("stopCron", stopCron, silent);
    await safe("logger.flush", () => logger.flush(), true);
    await safe("closeDb", closeDb, silent);
    await safe("logger.flush", () => logger.flush(), true);

    releasePidLock();
    process.exit(opts.fatal ? 1 : 0);
  }

  try {
    await acquirePidLock(config.DB_PATH, config.PORT, config.BASE_PATH);
  }
  catch (err) {
    await closeServices({ reason: "pid lock acquisition failed", fatal: true, err });
    return;
  }

  logger.info({ port: config.PORT, host: config.HOST }, "server started");

  // Optional sealed-file unlock for unattended restarts. Fires once,
  // best-effort, and always deletes the file regardless of outcome.
  void attemptSealedUnlock(config, logger);

  // Lode upgrade integration. No-op unless running under the lode supervisor.
  try {
    // Report serving to lode. When the DB is open, gate the signal on it
    // answering so `state.ready` reflects real readiness; when the app boots
    // encryption-locked (no DB), it still serves the unlock UI, so report
    // ready unconditionally. Writing phase -0 opts into the prepare handshake.
    await reportLodeServing({
      logger,
      // Omit the probe entirely when locked (exactOptionalPropertyTypes
      // rejects an explicit `undefined`); no probe means report ready as soon
      // as the server is up — correct, since a locked app serves the unlock UI.
      ...(db
        ? {
            probe: async () => {
              await db.run(sql`SELECT 1`);
              return true;
            },
          }
        : {}),
    });
    // Snapshot lode's config generation now so a later lode.toml edit shows up
    // as "config changed — restart to apply" in the admin About panel.
    captureLodeConfigBaseline();
    // Handle lode's staged-update prompt: checkpoint the WAL and flush logs
    // before acking, so the next version starts from a consolidated DB file.
    lodePrepare = startLodePrepareWatcher({
      logger,
      onPrepare: async () => {
        await db?.checkpoint();
        await logger.flush();
      },
    });
  }
  catch (err) {
    await closeServices({ reason: "lode readiness failed", fatal: true, err });
    return;
  }

  process.on("SIGINT", () => {
    void closeServices({ reason: "SIGINT", fatal: false });
  });
  process.on("SIGTERM", () => {
    void closeServices({ reason: "SIGTERM", fatal: false });
  });
  // External logrotate hook: reopen the log fd in place.
  process.on("SIGHUP", () => {
    logger.info("received SIGHUP — reopening log file");
    logger.reopen();
  });
  process.on("uncaughtException", (err) => {
    void closeServices({ reason: "uncaught exception", fatal: true, err });
  });
  process.on("unhandledRejection", (err) => {
    void closeServices({ reason: "unhandled rejection", fatal: true, err });
  });
})();
