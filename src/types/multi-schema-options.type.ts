import type { MigrateOptions } from './migrate-options.type';

/** Опции многосхемного запуска: те же, что у `runMigrations`, кроме схемы и журнала — они у каждой схемы свои. */
export interface MultiSchemaOptions extends Omit<MigrateOptions, 'schema' | 'migrationsSchema'> {
  /** Схемы (по схеме на арендатора); каждая — свой журнал в ней же и свой `search_path`. */
  readonly schemas: readonly string[];
  /** Продолжать со следующей схемы после отказа (по умолчанию — остановиться на первом). */
  readonly continueOnError?: boolean;
}
