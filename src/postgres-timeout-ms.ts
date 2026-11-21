import { POSTGRES_LIMIT } from './constants/postgres-limit.constant';

/** Потолок Postgres: целое > 0 и не больше int4 мс. 0 у Postgres — «ждать вечно», ровно то, от чего потолок защищает. */
export function postgresTimeoutMs(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > POSTGRES_LIMIT.MAX_TIMEOUT_MS) {
    throw new Error(
      `${name} — целое больше нуля и не больше ${POSTGRES_LIMIT.MAX_TIMEOUT_MS}, получено ${value}`,
    );
  }
  return value;
}
