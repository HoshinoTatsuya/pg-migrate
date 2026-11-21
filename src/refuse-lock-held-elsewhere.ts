import type { Client } from 'pg';

import { LOCK_KEY_SQL, type LockKeyHash } from './constants/lock-key-hash.constant';

/**
 * Лок миграций обязан держать ЭТА сессия. Под пулером в transaction mode
 * (PgBouncer, Odyssey) соседние запросы уходят в разные соединения сервера:
 * сессионный advisory-лок остаётся на чужом соединении, а миграции идут без
 * него — два мигратора применяли бы одно и то же. Обнаруживается одним
 * запросом сразу после взятия.
 */
export async function refuseLockHeldElsewhere(
  client: Client,
  lockKey: string,
  hash: LockKeyHash,
): Promise<void> {
  const { rows } = await client.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1 AND l.pid = pg_backend_pid()
          AND ((l.classid::bigint << 32) | l.objid::bigint) = ${LOCK_KEY_SQL[hash]}
     ) AS held`,
    [lockKey],
  );
  if (rows[0]?.held !== true) {
    throw new Error(
      `Миграции не применены: лок миграций «${lockKey}» взят, но не этой сессией — соединение идёт через ` +
        'пулер в transaction mode (PgBouncer, Odyssey), и запросы попадают в разные соединения сервера. ' +
        'Мигратору нужно прямое соединение с базой или пулер в session mode.',
    );
  }
}
