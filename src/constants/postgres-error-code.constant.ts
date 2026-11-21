import { deepFreeze } from '../deep-freeze';

/** Коды SQLSTATE, на которые библиотека реагирует отдельно. */
export const POSTGRES_ERROR_CODE = {
  /** lock_not_available — так Postgres отвечает на истёкший lock_timeout. */
  LOCK_NOT_AVAILABLE: '55P03',
  /** in_failed_sql_transaction — сессия в прерванной транзакции, до ROLLBACK любой запрос отказывает. */
  IN_FAILED_SQL_TRANSACTION: '25P02',
  /**
   * unique_violation — так отвечает второй из двух одновременных `CREATE SCHEMA
   * IF NOT EXISTS` одной схемы (индекс каталога pg_namespace), а не «уже есть».
   */
  UNIQUE_VIOLATION: '23505',
  /** duplicate_schema. */
  DUPLICATE_SCHEMA: '42P06',
} as const;

deepFreeze(POSTGRES_ERROR_CODE);
