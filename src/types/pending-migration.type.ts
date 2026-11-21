import type { MigrationMeta } from 'drizzle-orm/migrator';

import type { MigrationDirectives } from './migration-directives.type';

/** Ожидающая миграция: номер записи журнала, тег, файл drizzle и заголовок. */
export interface PendingMigration {
  readonly index: number;
  readonly tag: string;
  readonly file: MigrationMeta;
  readonly directives: MigrationDirectives;
}
