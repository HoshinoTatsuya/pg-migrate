import type { MigrationPhase } from './migration-phase.type';
import type { StepContext } from './step-context.type';

/** Контекст применения: шагу — его часть, планированию — нарезка и фаза. */
export interface ApplyContext extends StepContext {
  readonly transactionPerMigration: boolean;
  readonly phase: MigrationPhase | undefined;
  readonly slowMigrationMs: number;
}
