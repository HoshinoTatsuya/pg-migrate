import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { Client } from 'pg';

import { quoteIdent } from './quote-ident';
import type { JournalLocation } from './types/journal-location.type';

/** Запись миграции в журнал drizzle — тот же хэш и метка, что записал бы drizzle. */
export async function recordInJournal(
  client: Client,
  journal: JournalLocation,
  file: MigrationMeta,
): Promise<void> {
  await client.query(
    `INSERT INTO ${quoteIdent(journal.schema)}.${quoteIdent(journal.table)} ("hash", "created_at") VALUES ($1, $2)`,
    [file.hash, file.folderMillis],
  );
}
