import type { Client } from 'pg';

import type { LockKeyHash } from '../constants/lock-key-hash.constant';
import type { MigrationPhase } from './migration-phase.type';

export interface MigrateOptions {
  /** Ключ advisory-лока: `'<сервис>:schema-migrations'`. Свой у каждого сервиса одной базы. */
  readonly lockKey: string;
  /** Каталог миграций drizzle-kit (`meta/_journal.json` + `*.sql`). */
  readonly migrationsFolder: string;
  readonly lockTimeoutMs?: number;
  /** Потолок ожидания advisory-лока (по умолчанию MIGRATE_DEFAULTS.LOCK_WAIT_MS). */
  readonly lockWaitMs?: number;
  /**
   * Интервал опроса лока, мс (по умолчанию MIGRATE_DEFAULTS.LOCK_POLL_MS):
   * больше нуля и не больше TIMER_LIMIT.MAX_DELAY_MS, иначе отказ до лока.
   */
  readonly lockPollMs?: number;
  /**
   * Схема, в которой проверяются INVALID-индексы. Журнал миграций она НЕ
   * переносит (журнал — `migrationsSchema`): перенос по умолчанию сменил бы
   * журнал у тех, кто уже задал схему, и drizzle применил бы все миграции
   * заново. Схема задана, а `migrationsSchema` нет — строка в журнал деплоя.
   * Заданный `migrationsSchema` проверяется на INVALID-индексы тоже.
   */
  readonly schema?: string;
  /**
   * Под локом, ДО миграций: пометка базовой миграции (baseline adoption) и
   * прочее, что обязано идти в той же сессии, что держит лок.
   */
  readonly beforeMigrate?: (client: Client) => Promise<void>;
  /** Под локом, ПОСЛЕ миграций: например, проверка каталога схемы. */
  readonly afterMigrate?: (client: Client) => Promise<void>;
  readonly log: (line: string) => void;
  /**
   * Отмена (SIGTERM пода, дедлайн джобы): прерывает ожидание лока и не даёт
   * начать миграции. Уже идущую миграцию drizzle не прерывает — её откатит
   * сервер вместе с сессией, если вызывающий закроет соединение.
   */
  readonly signal?: AbortSignal;
  /** Число лока из ключа: `hashtext` (по умолчанию, 32 бита) или `int8` (64 бита). */
  readonly lockKeyHash?: LockKeyHash;
  /**
   * Схема и таблица журнала drizzle (по умолчанию `drizzle.__drizzle_migrations`).
   * Журнал по умолчанию общий для всех сервисов базы, которые его не задали, а
   * drizzle применяет только миграции НОВЕЕ последней записи журнала: миграция
   * сервиса старше чужой последней записи молча пропускается. Сервисам,
   * делящим базу, — свой журнал.
   */
  readonly migrationsSchema?: string;
  readonly migrationsTable?: string;
  /**
   * Потолки сессии мигратора, мс (целые > 0); по умолчанию не ставятся:
   * миграция данных законно идёт минутами. Под PgBouncer в session mode или
   * напрямую; в transaction mode мигратор не работает вовсе (сессионный лок).
   */
  readonly statementTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  /**
   * Повтор миграций, отказавших по `lock_timeout` (55P03): чужая транзакция
   * держала таблицу. Транзакция шага откатывается целиком; шаг вне транзакции —
   * нет, и если он оставил INVALID-индекс, повтора не будет (IF NOT EXISTS
   * пропустил бы недостроенный индекс), пока его не уберут вручную или опцией
   * `cleanupInvalidIndexes`. Перед каждым повтором — проверка INVALID-индексов.
   * По умолчанию выключен — деплой отказывает сразу, как до 0.4.0.
   * Пауза — `backoffMs × 2^(попытка−1)` с разбросом.
   */
  readonly lockTimeoutRetry?: { readonly attempts: number; readonly backoffMs: number };
  /**
   * Ещё схемы для проверки INVALID-индексов до миграций — сверх `schema` и
   * `migrationsSchema`: таблицы сервиса бывают и в третьей схеме.
   */
  readonly invalidIndexSchemas?: readonly string[];
  /**
   * `lock_timeout` шагов ВНЕ транзакции, мс (по умолчанию
   * `MIGRATE_DEFAULTS.NO_TRANSACTION_LOCK_TIMEOUT_MS`, 10 мин). `CREATE INDEX
   * CONCURRENTLY` ждёт конца каждой транзакции, пишущей в таблицу или держащей
   * старый снимок; под общим `lockTimeoutMs` он отказывал при любом писателе
   * старше потолка и оставлял INVALID-индекс. Ожидание CIC запись не блокирует.
   */
  readonly noTransactionLockTimeoutMs?: number;
  /**
   * Убирать INVALID-индексы, оставленные упавшим шагом вне транзакции
   * (`DROP INDEX CONCURRENTLY`), — тогда повтор по `lockTimeoutRetry` строит их
   * заново. Убираются только индексы, которых до шага не было. По умолчанию
   * выключено: отказ с командой уборки в тексте.
   */
  readonly cleanupInvalidIndexes?: boolean;
  /**
   * Каждая транзакционная миграция — своей транзакцией. По умолчанию все
   * ожидающие подряд идут одной (как `migrate` drizzle): `ACCESS EXCLUSIVE`
   * ранней миграции держится весь бэкфилл поздней. С опцией отказ поздней не
   * откатывает ранние — они остаются применёнными и записанными в журнал.
   */
  readonly transactionPerMigration?: boolean;
  /**
   * Фаза запуска (expand/contract, `MIGRATION_PHASE`). `expand` — до выкатки
   * кода: применяется всё до первой ожидающей contract-миграции (пометка
   * `-- pg-migrate:phase=contract`), она и следующие откладываются. `contract`
   * — после выкатки: отказ, если перед contract-миграцией есть неприменённые
   * (код выкатывался без них). Не задана — фазы не учитываются.
   */
  readonly phase?: MigrationPhase;
  /** Миграция дольше — строка-предупреждение (по умолчанию `MIGRATE_DEFAULTS.SLOW_MIGRATION_MS`). */
  readonly slowMigrationMs?: number;
}
