import type { Client } from 'pg';

import { abortableDelay } from './abortable-delay';
import { LOCK_KEY_SQL, type LockKeyHash } from './constants/lock-key-hash.constant';
import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { describeLockHolder } from './describe-lock-holder';
import type { MigrateOptions } from './types/migrate-options.type';

/**
 * Advisory-лок миграций с потолком ожидания. Ждущий запуск таблиц не держит,
 * поэтому `lock_timeout` к нему не применяется (иначе он отказал бы, пока
 * первый честно работает), но бессрочно ждать нельзя: держатель может быть
 * зависшей сессией упавшего хоста. Каждые LOCK_REPORT_EVERY_MS — строка с
 * держателем (pid, приложение, состояние, начало), по потолку — отказ с ним же.
 */
export async function acquireMigrationLock(
  client: Client,
  options: MigrateOptions,
  hash: LockKeyHash,
  pollMs: number,
): Promise<void> {
  const waitMs = options.lockWaitMs ?? MIGRATE_DEFAULTS.LOCK_WAIT_MS;
  const startedAt = Date.now();
  let reportedAt = Number.NEGATIVE_INFINITY;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${LOCK_KEY_SQL[hash]}) AS locked`,
      [options.lockKey],
    );
    if (rows[0]?.locked === true) {
      return;
    }
    const waited = Date.now() - startedAt;
    const holder = await describeLockHolder(client, options.lockKey, hash);
    if (waited >= waitMs) {
      throw new Error(
        `Миграции не применены: лок миграций «${options.lockKey}» занят дольше ${waitMs} мс — ${holder}. ` +
          'Если держатель завис: SELECT pg_terminate_backend(<pid>) и повторить деплой.',
      );
    }
    if (Date.now() - reportedAt >= MIGRATE_DEFAULTS.LOCK_REPORT_EVERY_MS) {
      options.log(`жду лок миграций «${options.lockKey}» (${Math.round(waited / 1000)} с): ${holder}`);
      reportedAt = Date.now();
    }
    await abortableDelay(pollMs, options.signal);
  }
}
