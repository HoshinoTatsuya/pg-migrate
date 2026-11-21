import type { MigrationPhase } from './migration-phase.type';
import type { StepKind } from './step-kind.type';

/** Что заголовок файла миграции говорит о её применении. */
export interface MigrationDirectives {
  readonly kind: StepKind;
  readonly batchSize: number | undefined;
  readonly pauseMs: number | undefined;
  readonly phase: MigrationPhase | undefined;
}
