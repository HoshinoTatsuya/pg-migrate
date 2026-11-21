import { LOCK_KEY_HASH } from './constants/lock-key-hash.constant';
import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { MIGRATION_PHASE } from './constants/migration-phase.constant';
import { TIMER_LIMIT } from './constants/timer-limit.constant';
import { postgresTimeoutMs } from './postgres-timeout-ms';
import type { MigrateOptions } from './types/migrate-options.type';
import type { MigrationPhase } from './types/migration-phase.type';
import type { ResolvedMigrateSettings } from './types/resolved-migrate-settings.type';

/**
 * Проверка опций `runMigrations` ДО лока и до любого запроса: неверное число
 * отказывает здесь с именем опции, а не посреди деплоя под локом.
 */
export function resolveMigrateSettings(options: MigrateOptions): ResolvedMigrateSettings {
  const lockTimeoutMs = postgresTimeoutMs(
    'lockTimeoutMs',
    options.lockTimeoutMs ?? MIGRATE_DEFAULTS.LOCK_TIMEOUT_MS,
  );
  const noTransactionLockTimeoutMs = postgresTimeoutMs(
    'noTransactionLockTimeoutMs',
    options.noTransactionLockTimeoutMs ?? MIGRATE_DEFAULTS.NO_TRANSACTION_LOCK_TIMEOUT_MS,
  );
  if (typeof options.lockKey !== 'string' || options.lockKey.trim() === '') {
    throw new Error('lockKey пуст: сервисы одной базы взяли бы один и тот же лок');
  }
  if (options.lockKey !== options.lockKey.trim()) {
    // hashtext не обрезает пробелы: «k » и «k» — разные локи, и два запуска
    // одного сервиса с разным написанием ключа мигрировали бы параллельно.
    throw new Error(`lockKey с пробелами по краям («${options.lockKey}»): это другой лок, чем без них`);
  }
  const lockWaitMs = options.lockWaitMs ?? MIGRATE_DEFAULTS.LOCK_WAIT_MS;
  if (!Number.isInteger(lockWaitMs) || lockWaitMs <= 0) {
    throw new Error(`lockWaitMs — целое больше нуля, получено ${lockWaitMs}`);
  }
  const lockPollMs = options.lockPollMs ?? MIGRATE_DEFAULTS.LOCK_POLL_MS;
  if (!Number.isFinite(lockPollMs) || lockPollMs <= 0 || lockPollMs > TIMER_LIMIT.MAX_DELAY_MS) {
    // NaN, 0, отрицательное и больше потолка таймера setTimeout превращает в
    // 1 мс: ожидание занятого лока стало бы двумя запросами к базе в миллисекунду.
    throw new Error(
      `lockPollMs — число больше нуля и не больше ${TIMER_LIMIT.MAX_DELAY_MS}, получено ${lockPollMs}`,
    );
  }
  const hash = options.lockKeyHash ?? LOCK_KEY_HASH.hashtext;
  if (!Object.values(LOCK_KEY_HASH).includes(hash)) {
    throw new Error(`lockKeyHash — ${Object.values(LOCK_KEY_HASH).join(' | ')}, получено ${String(hash)}`);
  }
  const sessionSettings: [string, number][] = [['lock_timeout', lockTimeoutMs]];
  for (const [name, value] of [
    ['statement_timeout', options.statementTimeoutMs],
    ['idle_in_transaction_session_timeout', options.idleInTransactionTimeoutMs],
  ] as const) {
    if (value !== undefined) {
      sessionSettings.push([name, postgresTimeoutMs(name, value)]);
    }
  }
  for (const [name, value] of [
    ['migrationsSchema', options.migrationsSchema],
    ['migrationsTable', options.migrationsTable],
    ['schema', options.schema],
  ] as const) {
    if (value !== undefined && value.trim() === '') {
      throw new Error(`${name} пуст`);
    }
  }
  const retry = options.lockTimeoutRetry;
  if (
    retry !== undefined &&
    (!Number.isInteger(retry.attempts) ||
      retry.attempts < 1 ||
      !Number.isFinite(retry.backoffMs) ||
      retry.backoffMs < 0 ||
      retry.backoffMs > TIMER_LIMIT.MAX_DELAY_MS)
  ) {
    throw new Error(
      `lockTimeoutRetry — attempts целое ≥ 1, backoffMs от 0 до ${TIMER_LIMIT.MAX_DELAY_MS}, ` +
        `получено ${JSON.stringify(retry)}`,
    );
  }
  for (const extra of options.invalidIndexSchemas ?? []) {
    if (extra.trim() === '') {
      throw new Error('invalidIndexSchemas: пустое имя схемы');
    }
  }
  if (
    options.phase !== undefined &&
    !Object.values(MIGRATION_PHASE).includes(options.phase as MigrationPhase)
  ) {
    throw new Error(
      `phase — ${Object.values(MIGRATION_PHASE).join(' | ')}, получено ${String(options.phase)}`,
    );
  }
  const slowMigrationMs = options.slowMigrationMs ?? MIGRATE_DEFAULTS.SLOW_MIGRATION_MS;
  if (!Number.isFinite(slowMigrationMs) || slowMigrationMs <= 0) {
    throw new Error(`slowMigrationMs — число больше нуля, получено ${slowMigrationMs}`);
  }
  const schema = options.schema ?? MIGRATE_DEFAULTS.SCHEMA;
  const journal = {
    schema: options.migrationsSchema ?? MIGRATE_DEFAULTS.JOURNAL_SCHEMA,
    table: options.migrationsTable ?? MIGRATE_DEFAULTS.JOURNAL_TABLE,
  };
  return {
    lockTimeoutMs,
    noTransactionLockTimeoutMs,
    lockPollMs,
    hash,
    sessionSettings,
    schema,
    journal,
    // И схема журнала, если задана: её задают сервисы со своей схемой, и
    // таблицы сервиса нередко лежат там же. Журнал при этом не переносится.
    invalidIndexSchemas: [
      ...new Set([schema, options.migrationsSchema ?? schema, ...(options.invalidIndexSchemas ?? [])]),
    ],
    attempts: retry?.attempts ?? 1,
    backoffMs: retry?.backoffMs ?? 0,
    slowMigrationMs,
  };
}
