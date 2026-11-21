import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Client } from 'pg';

import { quoteIdent } from './quote-ident';
import type { JournalFile } from './types/journal-file.type';
import type { JournalLocation } from './types/journal-location.type';

/**
 * Номер снимка, с которым сверять базу: последней миграции каталога, ПРИМЕНЁННОЙ
 * в базе (по хэшу в журнале), а не последней записи `_journal.json`. После фазы
 * `expand` contract-миграции ещё не применены, и снимок последней записи описывал
 * бы схему, которой в базе нет. Журнала в базе нет — последняя запись (сверка
 * громко покажет, что не применено ничего); журнал есть, а ни одной миграции
 * каталога в нём нет — отказ: сверять не с чем, и пустой ответ значил бы
 * «расхождений нет».
 */
export async function snapshotEntry(
  client: Client,
  migrationsFolder: string,
  journalFile: JournalFile,
  journal: JournalLocation,
): Promise<number | undefined> {
  if (journalFile.entries.length === 0) {
    return undefined;
  }
  const last = journalFile.entries.length - 1;
  const qualified = `${quoteIdent(journal.schema)}.${quoteIdent(journal.table)}`;
  const exists = await client.query<{ journal: string | null }>('SELECT to_regclass($1) AS journal', [
    qualified,
  ]);
  if (exists.rows[0]?.journal === null || exists.rows[0]?.journal === undefined) {
    return last;
  }
  const applied = new Set(
    (await client.query<{ hash: string }>(`SELECT hash FROM ${qualified}`)).rows.map((row) => row.hash),
  );
  const files = readMigrationFiles({ migrationsFolder });
  for (let position = files.length - 1; position >= 0; position -= 1) {
    if (applied.has(files[position]?.hash as string)) {
      return position;
    }
  }
  throw new Error(
    `detectSchemaDrift: в журнале ${qualified} нет ни одной миграции каталога ${migrationsFolder} — сверять ` +
      'базу не с чем (миграции этого каталога не применялись или журнал другой: migrationsSchema/migrationsTable)',
  );
}
