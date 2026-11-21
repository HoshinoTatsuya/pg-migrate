import type { Client } from 'pg';

import { LOCK_KEY_SQL, type LockKeyHash } from './constants/lock-key-hash.constant';

/**
 * Кто держит advisory-лок ключа: строка для журнала деплоя. Только в этой
 * базе: advisory-лок действует в пределах базы, а `pg_locks` — весь кластер, и
 * сессия другой базы с тем же ключом (соседний сервис, параллельная тестовая
 * база) лок миграций не держит.
 */
export async function describeLockHolder(
  client: Client,
  lockKey: string,
  hash: LockKeyHash,
): Promise<string> {
  const { rows } = await client.query<{
    pid: number;
    application_name: string;
    state: string;
    since: string;
  }>(
    `SELECT a.pid, a.application_name, a.state, a.backend_start::text AS since
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND ((l.classid::bigint << 32) | l.objid::bigint) = ${LOCK_KEY_SQL[hash]}`,
    [lockKey],
  );
  if (rows.length === 0) {
    return 'держатель уже отпустил лок';
  }
  return rows
    .map(
      (row) => `держит pid ${row.pid} (${row.application_name || 'без имени'}, ${row.state}, с ${row.since})`,
    )
    .join('; ');
}
