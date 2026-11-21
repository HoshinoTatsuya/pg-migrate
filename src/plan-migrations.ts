import type { Client } from 'pg';

import { classifyStatementLock } from './classify-statement-lock';
import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { pendingMigrations } from './pending-migrations';
import { planSteps } from './plan-steps';
import type { MigrationPlan } from './types/migration-plan.type';
import type { PlanOptions } from './types/plan-options.type';

/**
 * План без применения (`--plan` деплоя): какие миграции пойдут, какими шагами
 * (в транзакции, вне её, порциями), какие операторы какую блокировку берут и
 * что отложено до фазы contract. Только чтение журнала — без лока миграций и
 * без изменений; те же проверки нарезки, что у `runMigrations` (неупорядоченные
 * метки, порядок фаз), — отказом. Основа CI-проверки «опасная миграция».
 */
export async function planMigrations(client: Client, options: PlanOptions): Promise<MigrationPlan> {
  const journal = {
    schema: options.migrationsSchema ?? MIGRATE_DEFAULTS.JOURNAL_SCHEMA,
    table: options.migrationsTable ?? MIGRATE_DEFAULTS.JOURNAL_TABLE,
  };
  const pending = await pendingMigrations(client, options.migrationsFolder, journal);
  const { steps, deferred } = planSteps(pending, {
    transactionPerMigration: options.transactionPerMigration === true,
    phase: options.phase,
  });
  return {
    steps: steps.map((step) => ({
      kind: step.kind,
      migrations: step.migrations.map((migration) => ({
        tag: migration.tag,
        when: migration.file.folderMillis,
        phase: migration.directives.phase,
        statements: migration.file.sql
          .filter((statement) => statement.trim() !== '')
          .map((statement) => ({ text: statement.trim(), lock: classifyStatementLock(statement) })),
      })),
    })),
    deferred: deferred.map((migration) => migration.tag),
  };
}
