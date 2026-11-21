import { deepFreeze } from '../deep-freeze';

/**
 * Пределы параметров Postgres. Потолки `lock_timeout`, `statement_timeout`,
 * `idle_in_transaction_session_timeout` — int4 в мс (`pg_settings.max_val`
 * 2147483647, ~24.8 суток): больше — отказ 22023 «Value exceeds integer
 * range», причём уже под локом. Проверяется до обращения к базе.
 * Имя объекта — не длиннее 63 байт (NAMEDATALEN − 1): длиннее Postgres молча
 * обрезает, и сверка сравнивает имена снимка уже обрезанными.
 */
export const POSTGRES_LIMIT = {
  MAX_TIMEOUT_MS: 2_147_483_647,
  MAX_IDENTIFIER_BYTES: 63,
} as const;

deepFreeze(POSTGRES_LIMIT);
