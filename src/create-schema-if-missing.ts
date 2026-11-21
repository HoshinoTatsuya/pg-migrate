import type { Client } from 'pg';

import { POSTGRES_ERROR_CODE } from './constants/postgres-error-code.constant';
import { quoteIdent } from './quote-ident';

/**
 * `CREATE SCHEMA IF NOT EXISTS`, переживающий одновременный запуск. Два
 * мигратора на новой схеме создают её одновременно: второй ждёт фиксации
 * первого на индексе каталога и получает 23505 (или 42P06), а не «уже есть».
 * Такой отказ, после которого схема существует, — успех: её создал соседний
 * запуск, а сами миграции он и этот разведут advisory-локом.
 */
export async function createSchemaIfMissing(client: Client, schema: string): Promise<void> {
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== POSTGRES_ERROR_CODE.UNIQUE_VIOLATION && code !== POSTGRES_ERROR_CODE.DUPLICATE_SCHEMA) {
      throw error;
    }
    const { rows } = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS exists',
      [schema],
    );
    if (rows[0]?.exists !== true) {
      throw error;
    }
  }
}
