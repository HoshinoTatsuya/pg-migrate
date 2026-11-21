import { connectWithRetry, type MigrationReport, runMigrations } from '@hoshinotatsuya/pg-migrate';

/**
 * A deploy step (init container, release job): wait for the database, apply pending drizzle-kit
 * migrations under an advisory lock, close the connection. Connect directly to Postgres or through a
 * pooler in SESSION mode — the lock and lock_timeout are session-level.
 */
export async function migrate(
  connectionString: string,
  migrationsFolder: string, // the drizzle-kit output: meta/_journal.json + *.sql
  log: (line: string) => void = console.log,
  signal?: AbortSignal, // e.g. aborted on SIGTERM
): Promise<MigrationReport> {
  const client = await connectWithRetry({ connectionString }, 60_000, 2_000, log, signal ? { signal } : {});
  try {
    const report = await runMigrations(client, {
      lockKey: 'billing:schema-migrations', // one key per application sharing the database
      migrationsFolder,
      log,
      lockTimeoutMs: 5_000, // set AFTER the lock: a waiting second migrator holds no table locks
      ...(signal ? { signal } : {}),
    });
    log(`migrations applied: ${report.steps.length} step(s) in ${report.durationMs} ms`);
    return report;
  } finally {
    await client.end();
  }
}
