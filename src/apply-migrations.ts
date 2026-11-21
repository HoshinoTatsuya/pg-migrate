import type { Client } from 'pg';

import { STEP_KIND } from './constants/step-kind.constant';
import { drizzleMigrate } from './drizzle-migrate';
import { MigrationStepError } from './migration-step.error';
import { pendingMigrations } from './pending-migrations';
import { planSteps } from './plan-steps';
import { runBatchedStep } from './run-batched-step';
import { runNoTransactionStep } from './run-no-transaction-step';
import type { ApplyContext } from './types/apply-context.type';
import type { StepReport } from './types/step-report.type';

/**
 * Применяет ожидающие миграции шагами (`planSteps`): транзакционные — тем же
 * `dialect.migrate`, что `migrate` drizzle (одной транзакцией на шаг, хэши и
 * журнал drizzle), помеченные — вне транзакции (`runNoTransactionStep`) или
 * порциями (`runBatchedStep`). Без пометок и без `transactionPerMigration` —
 * ровно одна транзакция drizzle на все ожидающие, как до 0.4.0.
 *
 * Каждый шаг — строка в лог с длительностью; дольше `slowMigrationMs` —
 * предупреждение. Отказ шага — `MigrationStepError` (какие миграции, каким
 * способом), исходный отказ — в `cause`.
 */
export async function applyMigrations(
  client: Client,
  migrationsFolder: string,
  context: ApplyContext,
): Promise<{ steps: StepReport[]; deferred: string[] }> {
  const pending = await pendingMigrations(client, migrationsFolder, context.journal);
  const { steps, deferred } = planSteps(pending, {
    transactionPerMigration: context.transactionPerMigration,
    phase: context.phase,
  });
  if (deferred.length > 0) {
    context.log(
      `фаза expand: отложены до фазы contract — ${deferred.map((migration) => migration.tag).join(', ')}`,
    );
  }
  if (steps.some((step) => step.kind !== STEP_KIND.transaction)) {
    // Журнал drizzle заводит сам в транзакционном шаге; шагу вне транзакции
    // он нужен до первой записи: пустой прогон заводит схему и таблицу.
    await drizzleMigrate(client, [], context.journal);
  }
  const reports: StepReport[] = [];
  for (const step of steps) {
    context.signal?.throwIfAborted();
    const tags = step.migrations.map((migration) => migration.tag);
    const started = performance.now();
    let batched: { rows: number; batches: number } | undefined;
    const [single] = step.migrations;
    if (step.kind === STEP_KIND.transaction || single === undefined) {
      try {
        await drizzleMigrate(
          client,
          step.migrations.map((migration) => migration.file),
          context.journal,
        );
      } catch (error) {
        throw new MigrationStepError(tags, step.kind, error);
      }
    } else {
      try {
        if (step.kind === STEP_KIND.noTransaction) {
          await runNoTransactionStep(client, single, context);
        } else {
          batched = await runBatchedStep(client, single, context);
        }
      } catch (error) {
        // Любой отказ шага — с тегом и видом: и проверка INVALID до операторов,
        // и потолок сессии, и запись в журнал после них.
        throw error instanceof MigrationStepError ? error : new MigrationStepError(tags, step.kind, error);
      }
    }
    const durationMs = performance.now() - started;
    reports.push({ tags, kind: step.kind, durationMs, ...batched });
    context.log(
      `применено: ${tags.join(', ')} (${step.kind}) за ${Math.round(durationMs)} мс` +
        (batched === undefined ? '' : `, порций ${batched.batches}, строк ${batched.rows}`),
    );
    if (durationMs >= context.slowMigrationMs) {
      context.log(
        `медленная миграция: ${tags.join(', ')} — ${Math.round(durationMs)} мс (порог ${context.slowMigrationMs} мс)`,
      );
    }
  }
  return { steps: reports, deferred: deferred.map((migration) => migration.tag) };
}
