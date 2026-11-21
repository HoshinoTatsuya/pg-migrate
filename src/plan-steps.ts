import { MIGRATION_PHASE } from './constants/migration-phase.constant';
import { STEP_KIND } from './constants/step-kind.constant';
import type { MigrationPhase } from './types/migration-phase.type';
import type { MigrationStep } from './types/migration-step.type';
import type { PendingMigration } from './types/pending-migration.type';

/**
 * Ожидающие миграции — шагами применения.
 *
 *  - Без пометок и без `transactionPerMigration` — ОДИН шаг транзакцией drizzle,
 *    как `migrate` drizzle (все ожидающие — одной транзакцией).
 *  - Иначе транзакционные подряд — один шаг (или по шагу на миграцию с
 *    `transactionPerMigration`), помеченная — свой шаг.
 *
 * Шаги режут журнал, и drizzle внутри шага применяет только миграции новее
 * последней записи журнала: миграция с меткой `when` не новее предыдущей была
 * бы пропущена молча. Поэтому при нарезке неупорядоченные метки — отказ.
 *
 * Фаза `expand` останавливается перед первой ожидающей contract-миграцией
 * (она и всё после неё — `deferred`). Фаза `contract` отказывает, если перед
 * ожидающей contract-миграцией стоят неприменённые: их не было при выкатке кода.
 */
export function planSteps(
  pending: readonly PendingMigration[],
  options: { readonly transactionPerMigration: boolean; readonly phase: MigrationPhase | undefined },
): { steps: MigrationStep[]; deferred: PendingMigration[] } {
  let applied = [...pending];
  let deferred: PendingMigration[] = [];
  const firstContract = pending.findIndex(
    (migration) => migration.directives.phase === MIGRATION_PHASE.contract,
  );
  if (options.phase === MIGRATION_PHASE.expand && firstContract >= 0) {
    applied = pending.slice(0, firstContract);
    deferred = pending.slice(firstContract);
  }
  if (options.phase === MIGRATION_PHASE.contract && firstContract > 0) {
    const before = pending.slice(0, firstContract).map((migration) => migration.tag);
    throw new Error(
      `фаза contract: перед contract-миграцией ${pending[firstContract]?.tag} не применены ${before.join(', ')} — ` +
        'код новой версии выкатывался без них. Сначала фаза expand (до выкатки кода), потом contract (после)',
    );
  }
  const split =
    options.transactionPerMigration ||
    applied.some((migration) => migration.directives.kind !== STEP_KIND.transaction);
  if (!split) {
    return {
      steps: applied.length === 0 ? [] : [{ kind: STEP_KIND.transaction, migrations: applied }],
      deferred,
    };
  }
  for (let index = 1; index < applied.length; index += 1) {
    const previous = applied[index - 1];
    const current = applied[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.file.folderMillis <= previous.file.folderMillis
    ) {
      throw new Error(
        `метки миграций не по порядку: ${current.tag} (when ${current.file.folderMillis}) не новее ` +
          `${previous.tag} (when ${previous.file.folderMillis}). Миграции применяются шагами, и drizzle ` +
          'пропустил бы её молча. Дайте ей метку новее предыдущей (поле when в meta/_journal.json)',
      );
    }
  }
  const steps: MigrationStep[] = [];
  for (const migration of applied) {
    const previous = steps.at(-1);
    if (
      migration.directives.kind === STEP_KIND.transaction &&
      !options.transactionPerMigration &&
      previous?.kind === STEP_KIND.transaction
    ) {
      steps[steps.length - 1] = {
        kind: STEP_KIND.transaction,
        migrations: [...previous.migrations, migration],
      };
    } else {
      steps.push({ kind: migration.directives.kind, migrations: [migration] });
    }
  }
  return { steps, deferred };
}
