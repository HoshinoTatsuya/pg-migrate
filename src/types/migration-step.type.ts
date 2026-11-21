import type { PendingMigration } from './pending-migration.type';
import type { StepKind } from './step-kind.type';

/** Шаг применения: одна транзакция drizzle на миграции шага или одна миграция вне транзакции. */
export interface MigrationStep {
  readonly kind: StepKind;
  readonly migrations: readonly PendingMigration[];
}
