import type { SchemaRunReport } from './types/schema-run-report.type';

/** Многосхемный запуск: хотя бы одна схема не мигрирована. Отчёт по каждой — в `reports`. */
export class MultiSchemaMigrationError extends Error {
  public override readonly name = 'MultiSchemaMigrationError';

  public constructor(public readonly reports: readonly SchemaRunReport[]) {
    const failed = reports.filter((report) => report.status === 'failed');
    super(
      `миграции не применены в схемах ${failed.map((report) => report.schema).join(', ')}` +
        (reports.some((report) => report.status === 'not-started')
          ? `; не начинались: ${reports
              .filter((report) => report.status === 'not-started')
              .map((report) => report.schema)
              .join(', ')}`
          : '') +
        `\n${failed
          .map(
            (report) =>
              `${report.schema}: ${report.error instanceof Error ? report.error.message.split('\n')[0] : String(report.error)}`,
          )
          .join('\n')}`,
    );
  }
}
