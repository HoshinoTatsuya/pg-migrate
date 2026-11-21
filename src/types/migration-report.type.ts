import type { StepReport } from './step-report.type';

/** Итог `runMigrations`: применённые шаги по порядку, отложенные до фазы contract и общая длительность. */
export interface MigrationReport {
  readonly steps: readonly StepReport[];
  readonly deferred: readonly string[];
  readonly durationMs: number;
}
