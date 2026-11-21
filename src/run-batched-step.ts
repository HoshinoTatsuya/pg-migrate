import type { Client } from 'pg';

import { abortableDelay } from './abortable-delay';
import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { MigrationStepError } from './migration-step.error';
import { recordInJournal } from './record-in-journal';
import { sqlWithoutLiterals } from './sql-without-literals';
import type { PendingMigration } from './types/pending-migration.type';
import type { StepContext } from './types/step-context.type';

/**
 * Порционная миграция (бэкфилл): каждый оператор повторяется в автокоммите,
 * пока не затронет ноль строк; `$1` — размер порции. Каждая порция — своя
 * короткая транзакция под общим `lock_timeout`: блокировки строк держатся
 * миллисекунды, а не весь бэкфилл. Отказ посреди оставляет сделанные порции
 * сделанными, записи в журнале нет — следующий запуск продолжает с места, если
 * оператор выбирает только необработанные строки (`WHERE … IS NULL LIMIT $1`).
 */
export async function runBatchedStep(
  client: Client,
  migration: PendingMigration,
  context: StepContext,
): Promise<{ rows: number; batches: number }> {
  const batchSize = migration.directives.batchSize ?? MIGRATE_DEFAULTS.BATCH_SIZE;
  const pauseMs = migration.directives.pauseMs ?? MIGRATE_DEFAULTS.BATCH_PAUSE_MS;
  let rows = 0;
  let batches = 0;
  try {
    for (const statement of migration.file.sql) {
      if (statement.trim() === '') {
        continue;
      }
      // `$1` в комментарии или строке — не параметр: лишний параметр сервер отвергает (08P01).
      const parameters = /\$1(?!\d)/.test(sqlWithoutLiterals(statement)) ? [batchSize] : undefined;
      for (;;) {
        context.signal?.throwIfAborted();
        const result = await client.query(statement, parameters);
        batches += 1;
        const affected = result.rowCount ?? 0;
        rows += affected;
        if (batches % MIGRATE_DEFAULTS.BATCH_REPORT_EVERY === 0) {
          context.log(`миграция ${migration.tag}: порций ${batches}, строк ${rows}`);
        }
        if (affected === 0) {
          break;
        }
        if (pauseMs > 0) {
          await abortableDelay(pauseMs, context.signal);
        }
      }
    }
  } catch (error) {
    throw new MigrationStepError([migration.tag], migration.directives.kind, error);
  }
  await recordInJournal(client, context.journal, migration.file);
  return { rows, batches };
}
