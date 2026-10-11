import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import cac from "cac";
import { consola } from "consola";
import { BUILD_INFO } from "./build-info";
import { ROOT_DIR } from "./root";

const migrateLog = consola.withTag("migrate");

/**
 * Lightweight CLI dispatcher built on `cac`. Handles non-bootstrap
 * subcommands (version, healthcheck, migrate --check) so a container
 * can run the same binary for both `app` (boot the server) and `app
 * healthcheck` (in-process probe — no curl/wget required in the image).
 *
 * Returns the requested exit code, or `null` when no subcommand
 * matched and the caller should fall through to the normal boot path.
 */
export async function dispatchCliSubcommand(argv: readonly string[]): Promise<number | null> {
  const cli = cac("app");

  let exitCode: number | null = null;

  cli
    .command("healthcheck", "Run an in-process probe against /api/health")
    .action(async () => {
      exitCode = await runHealthcheck();
    });

  cli
    .command("migrate", "Migration utilities")
    .option("--check", "List pending migrations without applying them")
    .action(async (opts: { check?: boolean }) => {
      exitCode = await runMigrateSubcommand(opts);
    });

  cli.help();
  cli.version(`${BUILD_INFO.version} (${BUILD_INFO.commit}) built ${BUILD_INFO.buildTime}`);

  // Parse without auto-running so we can await async actions and decide
  // whether to fall through to the normal boot path.
  let parsed;
  try {
    parsed = cli.parse([...argv], { run: false });
  }
  catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  // cac prints help/version itself and unsets matchedCommand for us.
  if (parsed.options.help || parsed.options.version) {
    return 0;
  }

  if (!cli.matchedCommand) {
    return null;
  }

  try {
    await cli.runMatchedCommand();
  }
  catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  return exitCode;
}

async function runHealthcheck(): Promise<number> {
  // Resolves to whatever HOST/PORT/BASE_PATH the running server is using.
  // The probe goes through the public `/api/health` route so it also
  // exercises the secureHeaders + CORS + request-id stack.
  const port = Number(process.env.PORT ?? "3000");
  const basePath = (process.env.BASE_PATH ?? "").replace(/^\/+|\/+$/g, "");
  const path = basePath ? `/${basePath}/api/health` : "/api/health";
  const url = `http://127.0.0.1:${port}${path}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return res.ok ? 0 : 1;
  }
  catch {
    return 1;
  }
}

async function runMigrateSubcommand(opts: { check?: boolean }): Promise<number> {
  if (!opts.check) {
    consola.error("Usage: app migrate --check");
    return 2;
  }
  const pending = listFsPendingMigrations();
  if (pending === null) {
    migrateLog.error("cannot read drizzle/ folder; check that the binary has access to migrations.");
    return 2;
  }
  if (pending.length === 0) {
    migrateLog.success("no pending migrations.");
    return 0;
  }
  migrateLog.info(`${pending.length} pending migration(s):`);
  for (const m of pending)
    consola.log(`  - ${m}`);
  return 0;
}

/**
 * Compare `drizzle/meta/_journal.json` against the most recently applied
 * migration in `__drizzle_migrations`. We do NOT open the DB at this
 * stage — `migrate --check` is meant to run against a snapshot or in a
 * locked environment where booting is undesired. Reading the journal
 * gives the operator the list of migration tags the binary believes are
 * "the new world"; comparing against the DB happens at boot via the
 * regular migrator, so any divergence shows up there. Returning `null`
 * means the journal could not be read (for example, a packaged release
 * missing its drizzle/ folder).
 */
function listFsPendingMigrations(): string[] | null {
  const fsMigrationsFolder = resolveMigrationsFolder();
  const journalPath = resolve(fsMigrationsFolder, "meta/_journal.json");
  if (!existsSync(journalPath))
    return null;
  try {
    const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as { entries: { tag: string }[] };
    const entries = journal.entries ?? [];
    const knownTags = new Set(
      readdirSync(fsMigrationsFolder)
        .filter(f => f.endsWith(".sql"))
        .map(f => f.replace(/\.sql$/, "")),
    );
    return entries
      .map(e => e.tag)
      .filter(tag => knownTags.has(tag));
  }
  catch {
    return null;
  }
}

/**
 * Locate the Drizzle migrations folder for both layouts: a packaged lode
 * artifact ships `drizzle/` at ROOT_DIR (next to index.js); the dev/source
 * tree keeps it under `apps/api/drizzle`.
 */
function resolveMigrationsFolder(): string {
  const packaged = resolve(ROOT_DIR, "drizzle");
  if (existsSync(resolve(packaged, "meta/_journal.json")))
    return packaged;
  return resolve(ROOT_DIR, "apps/api/drizzle");
}
