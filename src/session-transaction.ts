import type { Client } from 'pg';

import { POSTGRES_ERROR_CODE } from './constants/postgres-error-code.constant';
import { SESSION_TRANSACTION, type SessionTransaction } from './constants/session-transaction.constant';

/**
 * Состояние транзакции сессии: прерванная отвечает 25P02 на любой запрос, в
 * открытой время начала транзакции отличается от времени оператора. Отказ
 * другого рода (обрыв) — `unknown` и ошибка уборки.
 */
export async function sessionTransaction(client: Client, failures: unknown[]): Promise<SessionTransaction> {
  try {
    const { rows } = await client.query<{ open: boolean }>(
      'SELECT transaction_timestamp() <> statement_timestamp() AS open',
    );
    return rows[0]?.open === true ? SESSION_TRANSACTION.open : SESSION_TRANSACTION.none;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === POSTGRES_ERROR_CODE.IN_FAILED_SQL_TRANSACTION) {
      return SESSION_TRANSACTION.failed;
    }
    failures.push(error);
    return SESSION_TRANSACTION.unknown;
  }
}
