import { deepFreeze } from '../deep-freeze';

/**
 * Как ключ advisory-лока превращается в число.
 *
 * `hashtext` — 32 бита (так было до 0.2.0 и остаётся по умолчанию): на базе,
 * которую делят десятки сервисов, совпадение двух ключей уже не теоретическое
 * (парадокс дней рождения: ~1% на 9 300 ключей), а совпавшие ключи — это два
 * сервиса, ждущие миграций друг друга. `int8` — первые 64 бита md5 ключа.
 *
 * Смена способа — это СМЕНА ЛОКА: запуск со старым и запуск с новым способом
 * не исключают друг друга. Переключать, когда старых миграторов не осталось.
 */
export const LOCK_KEY_HASH = {
  hashtext: 'hashtext',
  int8: 'int8',
} as const;

export type LockKeyHash = (typeof LOCK_KEY_HASH)[keyof typeof LOCK_KEY_HASH];

/** SQL-выражение числа лока от ключа в параметре $1. */
export const LOCK_KEY_SQL: Record<LockKeyHash, string> = {
  hashtext: 'hashtext($1)::bigint',
  int8: "('x' || substr(md5($1), 1, 16))::bit(64)::bigint",
};

deepFreeze(LOCK_KEY_HASH);
