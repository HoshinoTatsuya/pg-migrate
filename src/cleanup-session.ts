import type { Client } from 'pg';

import { LOCK_KEY_SQL, type LockKeyHash } from './constants/lock-key-hash.constant';
import { SESSION_TRANSACTION } from './constants/session-transaction.constant';
import { sessionTransaction } from './session-transaction';

/**
 * RESET потолков сессии и снятие лока: клиент может быть не последним
 * пользователем сессии. Уборка не должна затирать причину отказа: при обрыве
 * соединения посреди миграции RESET бросал «not queryable», и наружу уходила
 * она, а не текст migrationFailure (внешний аудит 13.11.2026). Поэтому при
 * исходной ошибке отказ уборки проглатывается (лок снимет сервер вместе с
 * сессией); без исходной — это и есть ошибка вызова.
 *
 * Хук мог оставить транзакцию: в прерванной (25P02) не проходит ни один шаг
 * уборки, и лок оставался за сессией, которую вызывающий использует дальше; в
 * открытой RESET откатился бы вместе с ней. Такая транзакция откатывается
 * первой, а без исходной ошибки это отказ: работа хука в ней не записана.
 * Каждый шаг пробуется, даже если предыдущий упал, — снятие лока последним.
 */
export async function cleanupSession(
  client: Client,
  sessionSettings: readonly [string, number][],
  hash: LockKeyHash,
  lockKey: string,
  afterFailure: boolean,
): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (text: string, values?: unknown[]): Promise<void> => {
    try {
      await client.query(text, values);
    } catch (error) {
      failures.push(error);
    }
  };
  const state = await sessionTransaction(client, failures);
  const leftTransaction = state === SESSION_TRANSACTION.failed || state === SESSION_TRANSACTION.open;
  if (leftTransaction) {
    await attempt('ROLLBACK');
  }
  for (const [name] of sessionSettings) {
    await attempt(`RESET ${name}`);
  }
  await attempt(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL[hash]})`, [lockKey]);
  if (afterFailure) {
    return;
  }
  if (leftTransaction) {
    throw new Error(
      `Миграции применены, но afterMigrate оставил ${state === SESSION_TRANSACTION.failed ? 'прерванную' : 'незавершённую'} ` +
        'транзакцию: она откатана, её изменения не записаны. Хук обязан сам завершать свои транзакции (COMMIT/ROLLBACK).',
    );
  }
  if (failures.length > 0) {
    throw failures[0];
  }
}
