import {
  LOCK_KEY_HASH,
  MIGRATION_PHASE,
  type MigrationPhase,
  MigrationStepError,
  runMigrations,
} from '@hoshinotatsuya/pg-migrate';
import type { Client } from 'pg';

export async function migratePhase(client: Client, migrationsFolder: string, phase: MigrationPhase) {
  try {
    return await runMigrations(client, {
      lockKey: 'billing:schema-migrations',
      lockKeyHash: LOCK_KEY_HASH.int8, // 64-bit lock key (default: 32-bit hashtext)
      migrationsFolder,
      migrationsSchema: 'billing_meta', // own journal instead of the shared drizzle.__drizzle_migrations
      log: console.log,
      phase, // 'expand' before the new code is rolled out, 'contract' after it
      transactionPerMigration: true, // a late migration's failure does not roll back earlier ones
      lockTimeoutRetry: { attempts: 5, backoffMs: 200 }, // retry steps refused by lock_timeout (55P03)
      cleanupInvalidIndexes: true, // drop INVALID indexes left by a failed CONCURRENTLY step, then retry
      statementTimeoutMs: 10 * 60_000,
      idleInTransactionTimeoutMs: 60_000,
      beforeMigrate: async (c) => {
        // Runs under the lock, in the same session, before any migration (e.g. adopting a baseline).
        await c.query('SELECT 1');
      },
    });
  } catch (error) {
    if (error instanceof MigrationStepError) {
      // error.tags — the migration(s) of the failed step, error.kind — STEP_KIND, and
      // error.leftInvalidIndexes — INVALID indexes the step left behind.
    }
    throw error;
  }
}

export const isExpand = (phase: MigrationPhase): boolean => phase === MIGRATION_PHASE.expand;
