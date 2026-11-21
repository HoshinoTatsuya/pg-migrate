import type { Client } from 'pg';

import { quoteIdent } from './quote-ident';
import type { JournalLocation } from './types/journal-location.type';

/** Метка последней применённой миграции (как её берёт drizzle); журнала нет — минус бесконечность. */
export async function lastApplied(client: Client, journal: JournalLocation): Promise<number> {
  const qualified = `${quoteIdent(journal.schema)}.${quoteIdent(journal.table)}`;
  const exists = await client.query<{ journal: string | null }>('SELECT to_regclass($1) AS journal', [
    qualified,
  ]);
  if (exists.rows[0]?.journal === null || exists.rows[0]?.journal === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  const { rows } = await client.query<{ last: string | null }>(
    `SELECT max(created_at)::text AS last FROM ${qualified}`,
  );
  const value = rows[0]?.last;
  return value === null || value === undefined ? Number.NEGATIVE_INFINITY : Number(value);
}
