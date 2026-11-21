import type { MigrationPhase } from './migration-phase.type';
import type { StatementLock } from './statement-lock.type';
import type { StepKind } from './step-kind.type';

/** Что `runMigrations` сделал бы сейчас: шаги, миграции с операторами и блокировками, отложенные. */
export interface MigrationPlan {
  readonly steps: ReadonlyArray<{
    readonly kind: StepKind;
    readonly migrations: ReadonlyArray<{
      readonly tag: string;
      readonly when: number;
      readonly phase: MigrationPhase | undefined;
      readonly statements: ReadonlyArray<{ readonly text: string; readonly lock: StatementLock }>;
    }>;
  }>;
  readonly deferred: readonly string[];
}
