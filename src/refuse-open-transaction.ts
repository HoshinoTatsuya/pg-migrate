import type { Client } from 'pg';

import { SESSION_TRANSACTION } from './constants/session-transaction.constant';
import { sessionTransaction } from './session-transaction';

/**
 * Хук вернулся, оставив транзакцию сессии открытой или прерванной, — отказ до
 * миграций: транзакционный шаг drizzle пошёл бы внутри неё (его COMMIT
 * зафиксировал бы и работу хука), шаг вне транзакции — отказ 25001, а в
 * прерванной не прошёл бы ни один. Транзакцию откатит уборка сессии.
 */
export async function refuseOpenTransaction(client: Client, hook: string): Promise<void> {
  const failures: unknown[] = [];
  const state = await sessionTransaction(client, failures);
  if (failures.length > 0) {
    throw failures[0];
  }
  if (state === SESSION_TRANSACTION.open || state === SESSION_TRANSACTION.failed) {
    throw new Error(
      `Миграции не применены: ${hook} оставил ${state === SESSION_TRANSACTION.failed ? 'прерванную' : 'незавершённую'} ` +
        'транзакцию — миграции пошли бы внутри неё. Хук обязан сам завершать свои транзакции (COMMIT/ROLLBACK); ' +
        'она откатана.',
    );
  }
}
