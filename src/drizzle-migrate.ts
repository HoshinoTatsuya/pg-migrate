import type { MigrationMeta } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Client } from 'pg';

import type { JournalLocation } from './types/journal-location.type';

/**
 * Транзакция drizzle над заданными миграциями — тем же `dialect.migrate`, что
 * зовёт `migrate` drizzle (он лишь читает каталог и передаёт ВСЕ миграции):
 * журнал, хэши и правило «новее последней записи» — drizzle. Список миграций
 * передаётся прямо, без временной копии каталога: временный каталог требовал
 * записываемого tmpdir, а `readOnlyRootFilesystem` пода ронял ровно деплой с
 * миграцией вне транзакции. Пустой список заводит схему и таблицу журнала.
 */
export async function drizzleMigrate(
  client: Client,
  migrations: readonly MigrationMeta[],
  journal: JournalLocation,
): Promise<void> {
  const db = drizzle(client) as unknown as {
    dialect: { migrate(migrations: MigrationMeta[], session: unknown, config: object): Promise<void> };
    session: unknown;
  };
  await db.dialect.migrate([...migrations], db.session, {
    migrationsSchema: journal.schema,
    migrationsTable: journal.table,
  });
}
