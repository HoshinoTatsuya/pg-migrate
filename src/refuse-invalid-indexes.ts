import type { Client } from 'pg';

import { LEFTOVER_INDEX_NAME } from './constants/leftover-index-name.constant';
import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { quoteIdent } from './quote-ident';

/**
 * Отказ деплоя на INVALID-индексе схемы — ДО любых изменений.
 *
 * INVALID-индекс — след упавшего `CREATE INDEX CONCURRENTLY` или `REINDEX
 * CONCURRENTLY`. Postgres не выбирает его арбитром `ON CONFLICT`: вставка с
 * целью конфликта по нему отвечает 42P10 на КАЖДЫЙ вызов, а приложение
 * поднимается как ни в чём не бывало (так было в проде, пока проверки не
 * было).
 *
 * Обрубок пересборки (`_ccnew`, `_ccold`) — мусор рядом с целым индексом: о нём
 * строка с DROP, отказа нет. INVALID-индекс без такого суффикса — настоящий,
 * его пересобирают, а не удаляют (DROP молча снял бы ограничение).
 */
export async function refuseInvalidIndexes(
  client: Client,
  log: (line: string) => void,
  schema: string = MIGRATE_DEFAULTS.SCHEMA,
): Promise<void> {
  const result = await client.query<{ index: string; table: string }>(
    `SELECT c.relname AS index, t.relname AS table
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT i.indisvalid
      ORDER BY c.relname`,
    [schema],
  );
  for (const leftover of result.rows.filter((row) => LEFTOVER_INDEX_NAME.test(row.index))) {
    log(
      `индекс ${leftover.index} (${leftover.table}) INVALID — обрубок упавшей пересборки *_CONCURRENTLY, ` +
        `арбитром не бывает; убрать: DROP INDEX CONCURRENTLY ${quoteIdent(schema)}.${quoteIdent(leftover.index)}`,
    );
  }
  const broken = result.rows.filter((row) => !LEFTOVER_INDEX_NAME.test(row.index));
  if (broken.length > 0) {
    throw new Error(
      `INVALID-индексы в схеме ${schema}: ${broken.map((row) => `${row.index} (таблица ${row.table})`).join(', ')}. ` +
        'Postgres не выбирает INVALID-индекс арбитром ON CONFLICT: вставка с целью конфликта по нему отвечает ' +
        '42P10 на каждый вызов. Пересобрать до деплоя, каждый отдельным оператором вне транзакции: ' +
        // Со схемой и экранированием: команду копируют в psql как есть, а
        // search_path там может не содержать схему сервиса.
        broken
          .map((row) => `REINDEX INDEX CONCURRENTLY ${quoteIdent(schema)}.${quoteIdent(row.index)}`)
          .join('; ') +
        '. Уникальный индекс не пересоберётся, пока в таблице есть дубли его ключа: ' +
        // Планировщик ищет дубли по живому индексу и не видит их: поиск — без индексов.
        'сначала найти их с SET enable_indexscan = off.',
    );
  }
}
