import type { Client } from 'pg';

/** `lock_timeout` сессии мигратора (сессионный: мигратор держит своё соединение). */
export async function setLockTimeout(client: Client, ms: number): Promise<void> {
  await client.query("SELECT set_config('lock_timeout', $1, false)", [`${ms}ms`]);
}
