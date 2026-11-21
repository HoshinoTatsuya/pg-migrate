import type { MigrationReport } from './migration-report.type';

/** Итог миграций одной схемы многосхемного запуска. */
export interface SchemaRunReport {
  readonly schema: string;
  readonly status: 'applied' | 'failed' | 'not-started';
  readonly report?: MigrationReport;
  readonly error?: unknown;
}
