import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Client } from 'pg';

import { lastApplied } from './last-applied';
import { readDirectives } from './read-directives';
import { readJournalFile } from './read-journal-file';
import type { JournalLocation } from './types/journal-location.type';
import type { PendingMigration } from './types/pending-migration.type';

/**
 * Миграции, которые drizzle применил бы сейчас: метка новее последней
 * применённой. С заголовком каждой — как её применять.
 */
export async function pendingMigrations(
  client: Client,
  migrationsFolder: string,
  journal: JournalLocation,
): Promise<PendingMigration[]> {
  const journalFile = readJournalFile(migrationsFolder);
  const files = readMigrationFiles({ migrationsFolder });
  const last = await lastApplied(client, journal);
  return files.flatMap((file, index) => {
    if (file.folderMillis <= last) {
      return [];
    }
    const tag = journalFile.entries[index]?.tag ?? `#${index}`;
    const text = readFileSync(join(migrationsFolder, `${tag}.sql`), 'utf8');
    return [{ index, tag, file, directives: readDirectives(tag, text) }];
  });
}
