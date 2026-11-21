import type { MigrateOptions } from './migrate-options.type';

/** Опции плана — те же, что у `runMigrations`, от которых зависит нарезка и фаза. */
export type PlanOptions = Pick<
  MigrateOptions,
  'migrationsFolder' | 'migrationsSchema' | 'migrationsTable' | 'transactionPerMigration' | 'phase'
>;
