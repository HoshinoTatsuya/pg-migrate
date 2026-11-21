import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Client } from 'pg';

import { quoteIdent } from './quote-ident';

/**
 * Отказ деплоя на миграции, которую drizzle молча пропустит, — ДО любых изменений.
 *
 * drizzle применяет миграцию, только если её метка (`when` в
 * `meta/_journal.json`) новее ПОСЛЕДНЕЙ записи журнала в базе. Миграция из
 * ветки, влитой после более новой, получает метку старше применённой: drizzle
 * её не применит ни сейчас, ни потом, и ничего не скажет. Схема базы
 * расходится с кодом молча — до первого запроса к колонке, которой нет.
 *
 * Пропущенная — та, у которой метка не новее последней записи журнала, а в
 * журнале нет ни её хэша, ни её метки. Если метка в журнале есть, а хэш другой,
 * — применённую миграцию отредактировали: drizzle её тоже не тронет, но схема
 * совпадает с прежним текстом, поэтому это строка в логе, а не отказ. Но если
 * эту метку в журнале объясняет ДРУГОЙ файл каталога (его хэш применён), то это
 * вторая миграция с той же меткой — пропущенная, отказ.
 */
export async function refuseSkippedMigrations(
  client: Client,
  log: (line: string) => void,
  migrationsFolder: string,
  journal: { schema: string; table: string },
): Promise<void> {
  const qualified = `${quoteIdent(journal.schema)}.${quoteIdent(journal.table)}`;
  const exists = await client.query<{ journal: string | null }>('SELECT to_regclass($1) AS journal', [
    qualified,
  ]);
  if (exists.rows[0]?.journal === null || exists.rows[0]?.journal === undefined) {
    // Журнала ещё нет: drizzle применит всё по порядку.
    return;
  }
  const applied = (
    await client.query<{ hash: string; created_at: string }>(`SELECT hash, created_at FROM ${qualified}`)
  ).rows;
  if (applied.length === 0) {
    return;
  }
  const last = Math.max(...applied.map((row) => Number(row.created_at)));
  const appliedHashes = new Set(applied.map((row) => row.hash));
  const appliedMillis = new Set(applied.map((row) => Number(row.created_at)));

  const files = readMigrationFiles({ migrationsFolder });
  const tags = readJournalTags(migrationsFolder);
  const behind = files
    .map((file, idx) => ({ ...file, tag: tags[idx] ?? `#${idx}` }))
    .filter((file) => file.folderMillis <= last && !appliedHashes.has(file.hash));

  // Метка применённой записи «занята» другим файлом каталога, чей хэш применён, —
  // этот файл не правка применённой миграции, а другая миграция с той же меткой:
  // drizzle пропустит её так же молча.
  const appliedHere = new Set(
    files.filter((file) => appliedHashes.has(file.hash)).map((file) => file.folderMillis),
  );
  const edited = behind.filter(
    (file) => appliedMillis.has(file.folderMillis) && !appliedHere.has(file.folderMillis),
  );
  if (edited.length > 0) {
    log(
      `применённые миграции отредактированы после применения: ${edited.map((file) => file.tag).join(', ')} — ` +
        'drizzle их не повторит, база соответствует прежнему тексту',
    );
  }
  const skipped = behind.filter((file) => !edited.includes(file));
  if (skipped.length > 0) {
    throw new Error(
      `миграции ${skipped.map((file) => `${file.tag} (when ${file.folderMillis})`).join(', ')} старше последней ` +
        `применённой (${last}, ${new Date(last).toISOString()}), а в журнале ${qualified} их нет: drizzle пропустил бы ` +
        'их молча и навсегда. Обычно это миграция из ветки, влитой после более новой. Дайте ей метку новее ' +
        'последней применённой (поле when в meta/_journal.json и порядок записей), чтобы она применилась.',
    );
  }
}

/** Теги записей журнала drizzle-kit — в том же порядке, что readMigrationFiles. */
function readJournalTags(migrationsFolder: string): string[] {
  const parsed = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries?: Array<{ tag?: unknown }>;
  };
  return (parsed.entries ?? []).map((entry, idx) => (typeof entry.tag === 'string' ? entry.tag : `#${idx}`));
}
