import type { Client } from 'pg';

import type { InvalidIndex } from './types/invalid-index.type';

/** INVALID-индексы схем одним запросом, по схеме и имени. */
export async function listInvalidIndexes(
  client: Client,
  schemas: readonly string[],
): Promise<InvalidIndex[]> {
  const { rows } = await client.query<InvalidIndex>(
    `SELECT n.nspname AS schema, c.relname AS index, t.relname AS table
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND NOT i.indisvalid
      ORDER BY n.nspname, c.relname`,
    [schemas],
  );
  return rows;
}
