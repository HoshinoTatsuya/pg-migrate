import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JournalFile } from './types/journal-file.type';

/** Журнал drizzle-kit каталога миграций; без записей или не той формы — отказ с путём. */
export function readJournalFile(migrationsFolder: string): JournalFile {
  const path = join(migrationsFolder, 'meta', '_journal.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<JournalFile>;
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`${path}: нет массива entries`);
  }
  return parsed as JournalFile;
}
