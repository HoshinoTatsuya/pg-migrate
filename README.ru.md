# @hoshinotatsuya/pg-migrate

[![npm](https://img.shields.io/npm/v/@hoshinotatsuya/pg-migrate.svg)](https://www.npmjs.com/package/@hoshinotatsuya/pg-migrate)
[![CI](https://github.com/HoshinoTatsuya/pg-migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/HoshinoTatsuya/pg-migrate/actions/workflows/ci.yml)

[English version](README.md) · [Changelog](CHANGELOG.md)

Запуск миграций [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) на Postgres во время деплоя, который не
делает опасное молча.

`migrate()` drizzle-orm хорош на ноутбуке. На деплое он встречает две реплики, стартующие разом, длинную транзакцию
на таблице, упавший `CREATE INDEX CONCURRENTLY`, ветку миграций, влитую после более новой, и под, убитый посреди
прогона. Пакет выполняет те же миграции (тот же каталог, тот же журнал, те же хэши) и:

| Проблема | Что делает пакет |
|---|---|
| два мигратора разом | сессионный advisory-лок; второй ждёт с потолком (`lockWaitMs`) и раз в 30 с пишет, кто держит лок |
| миграция бесконечно ждёт за длинной транзакцией и блокирует все запросы в очереди за ней | `lock_timeout` (5 с) ПОСЛЕ взятия лока; по выбору — повтор на 55P03 |
| INVALID-индекс после упавшего `CREATE INDEX CONCURRENTLY` | отказ до любых изменений с точной командой `REINDEX`/`DROP` |
| drizzle молча пропускает миграцию с меткой старше последней применённой | отказ с именами таких миграций |
| `CREATE INDEX CONCURRENTLY` нельзя в транзакции (drizzle гонит всё одной) | заголовок `-- pg-migrate:no-transaction`: оператор за оператором в автокоммите, запись в журнал как у drizzle |
| бэкфилл `UPDATE` блокирует таблицу целиком | `-- pg-migrate:batched`: порциями, пока не затронет ноль строк |
| новому коду на время выкатки нужна старая схема | фазы expand/contract |
| «Failed query: …» без причины | сообщение, `detail` и `hint` Postgres в тексте ошибки |
| сессия мёртвого пода или разрыв сервером роняют или вешают деплой | `signal`, обработчик `'error'`, уборка, которая не прячет исходный отказ |

Плюс план без применения с блокировкой каждого оператора, сверка схемы со снимками drizzle-kit и запуск по схемам
арендаторов.

## Установка

```sh
pnpm add @hoshinotatsuya/pg-migrate drizzle-orm pg
pnpm add -D drizzle-kit @types/pg
```

Peer-зависимости: `drizzle-orm >=0.45.2 <0.46`, `pg ^8.18.0`, необязательно `@types/pg >=8.15.0`. Миграции — обычный
каталог drizzle-kit (`meta/_journal.json`, `*.sql`, `meta/*_snapshot.json`). Пакет CommonJS с декларациями типов.

## Быстрый старт

<!-- код ниже — examples/quick-start.ts: проходит typecheck и исполняется на Postgres в наборе тестов -->
<!-- example: examples/quick-start.ts -->
```ts
import { connectWithRetry, type MigrationReport, runMigrations } from '@hoshinotatsuya/pg-migrate';

/**
 * A deploy step (init container, release job): wait for the database, apply pending drizzle-kit
 * migrations under an advisory lock, close the connection. Connect directly to Postgres or through a
 * pooler in SESSION mode — the lock and lock_timeout are session-level.
 */
export async function migrate(
  connectionString: string,
  migrationsFolder: string, // the drizzle-kit output: meta/_journal.json + *.sql
  log: (line: string) => void = console.log,
  signal?: AbortSignal, // e.g. aborted on SIGTERM
): Promise<MigrationReport> {
  const client = await connectWithRetry({ connectionString }, 60_000, 2_000, log, signal ? { signal } : {});
  try {
    const report = await runMigrations(client, {
      lockKey: 'billing:schema-migrations', // one key per application sharing the database
      migrationsFolder,
      log,
      lockTimeoutMs: 5_000, // set AFTER the lock: a waiting second migrator holds no table locks
      ...(signal ? { signal } : {}),
    });
    log(`migrations applied: ${report.steps.length} step(s) in ${report.durationMs} ms`);
    return report;
  } finally {
    await client.end();
  }
}
```

Зовите это из шага деплоя, который идёт до старта новой версии (init-контейнер или job Kubernetes, release-фаза,
шаг CI). Подключение — **напрямую к Postgres** или через пулер в **session mode**: advisory-лок и `lock_timeout`
сессионные, а в transaction mode они оказались бы на разных серверных соединениях (пакет это распознаёт и
отказывает).

Перед переходом с мигратора без этих проверок один раз поищите INVALID-индексы — первый деплой на них откажет:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

## API

### `runMigrations(client, options)` → `Promise<MigrationReport>`

Порядок внутри: advisory-лок (`pg_try_advisory_lock` в цикле, потолок `lockWaitMs`) → `lock_timeout` → отказ на
INVALID-индексах и пропущенных миграциях → `beforeMigrate` → миграции → проверка INVALID после применения →
`afterMigrate` → в `finally`: откат транзакции, оставленной хуком, `RESET` параметров сессии, снятие лока (каждый шаг
уборки пробуется, даже если предыдущий упал, и отказ уборки никогда не подменяет исходную ошибку). Отчёт: `steps`
(`{ tags, kind, durationMs, rows?, batches? }`), `deferred` (contract-миграции, отложенные в фазе `expand`),
`durationMs`.

`client` — подключённый `pg.Client` (не пул: одна сессия на весь прогон). Опции (`MigrateOptions`; умолчания —
`MIGRATE_DEFAULTS`):

| Опция | По умолчанию | Что делает |
|---|---|---|
| `lockKey` | обязательна | ключ advisory-лока, например `'<приложение>:schema-migrations'`; свой у каждого приложения одной базы. Пустой или с пробелами по краям — отказ |
| `migrationsFolder` | обязательна | каталог drizzle-kit |
| `log` | обязательна | `(line) => void` — ход, ожидания, предупреждения |
| `lockTimeoutMs` | 5 000 | `lock_timeout` операторов миграций, ставится после лока |
| `lockWaitMs` | 900 000 (15 мин) | потолок ожидания advisory-лока; дальше — отказ с держателем |
| `lockPollMs` | 2 000 | интервал опроса лока (`> 0`, ≤ 2³¹−1) |
| `lockKeyHash` | `'hashtext'` | `LOCK_KEY_HASH.hashtext` (32 бита) или `.int8` (первые 64 бита md5). Смена — смена лока: переключать, когда старых миграторов не осталось |
| `migrationsSchema`, `migrationsTable` | `drizzle`, `__drizzle_migrations` | журнал drizzle. Журнал по умолчанию общий у всех приложений базы, не задавших свой, а drizzle применяет только миграции новее последней строки журнала: каждому приложению — свой |
| `schema` | `public` | схема проверки INVALID-индексов (журнал она НЕ переносит) |
| `invalidIndexSchemas` | — | ещё схемы для проверки INVALID-индексов |
| `beforeMigrate`, `afterMigrate` | — | `(client) => Promise<void>` под локом, до/после миграций (пометка базовой миграции, проверка каталога). Хук, оставивший открытую или прерванную транзакцию, — отказ |
| `signal` | — | прерывает ожидание лока и не даёт начать миграции; идущую миграцию drizzle не прерывает (закройте соединение — сервер её откатит) |
| `statementTimeoutMs`, `idleInTransactionTimeoutMs` | не ставятся | потолки сессии на прогон, сбрасываются после |
| `lockTimeoutRetry` | выключен | `{ attempts, backoffMs }`: повтор шагов, отказавших по `lock_timeout` (55P03); пауза `backoffMs × 2^(попытка−1)` с разбросом |
| `noTransactionLockTimeoutMs` | 600 000 (10 мин) | `lock_timeout` шагов вне транзакции (`CREATE INDEX CONCURRENTLY` ждёт каждого старого писателя и снимка) |
| `cleanupInvalidIndexes` | `false` | убирать INVALID-индексы, созданные упавшим шагом вне транзакции, чтобы повтор построил их заново |
| `transactionPerMigration` | `false` | своя транзакция на миграцию вместо одной на все ожидающие (`ACCESS EXCLUSIVE` ранней не держится весь бэкфилл поздней) |
| `phase` | — | `MIGRATION_PHASE.expand` / `.contract` (ниже) |
| `slowMigrationMs` | 60 000 | шаг дольше — строка-предупреждение |

<!-- example: examples/deploy-options.ts -->
```ts
import {
  LOCK_KEY_HASH,
  MIGRATION_PHASE,
  type MigrationPhase,
  MigrationStepError,
  runMigrations,
} from '@hoshinotatsuya/pg-migrate';
import type { Client } from 'pg';

export async function migratePhase(client: Client, migrationsFolder: string, phase: MigrationPhase) {
  try {
    return await runMigrations(client, {
      lockKey: 'billing:schema-migrations',
      lockKeyHash: LOCK_KEY_HASH.int8, // 64-bit lock key (default: 32-bit hashtext)
      migrationsFolder,
      migrationsSchema: 'billing_meta', // own journal instead of the shared drizzle.__drizzle_migrations
      log: console.log,
      phase, // 'expand' before the new code is rolled out, 'contract' after it
      transactionPerMigration: true, // a late migration's failure does not roll back earlier ones
      lockTimeoutRetry: { attempts: 5, backoffMs: 200 }, // retry steps refused by lock_timeout (55P03)
      cleanupInvalidIndexes: true, // drop INVALID indexes left by a failed CONCURRENTLY step, then retry
      statementTimeoutMs: 10 * 60_000,
      idleInTransactionTimeoutMs: 60_000,
      beforeMigrate: async (c) => {
        // Runs under the lock, in the same session, before any migration (e.g. adopting a baseline).
        await c.query('SELECT 1');
      },
    });
  } catch (error) {
    if (error instanceof MigrationStepError) {
      // error.tags — the migration(s) of the failed step, error.kind — STEP_KIND, and
      // error.leftInvalidIndexes — INVALID indexes the step left behind.
    }
    throw error;
  }
}

export const isExpand = (phase: MigrationPhase): boolean => phase === MIGRATION_PHASE.expand;
```

### Заголовки файлов миграций

Строки `-- pg-migrate:` подряд с первой строки файла `.sql` (`MIGRATION_DIRECTIVE`). Незнакомая директива или
параметр — отказ с именем файла: опечатка не должна молча выполнить бэкфилл одним `UPDATE`.

```sql
-- pg-migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS items_status_idx ON items (status)
```

Выполняется вне транзакции, оператор за оператором (один оператор на блок `--> statement-breakpoint`), затем
миграция записывается в журнал drizzle. Каждый оператор обязан быть повторяемым (`IF NOT EXISTS`): отказ оставляет
сделанные операторы без записи в журнале, и следующий деплой выполнит файл снова. Индекс, оставшийся INVALID,
отвергается до следующего прогона и никогда не записывается применённым.

```sql
-- pg-migrate:batched batch=5000 pause=20
UPDATE items SET status = 'new' WHERE id IN (SELECT id FROM items WHERE status IS NULL ORDER BY id LIMIT $1)
```

Каждый оператор повторяется в автокоммите, пока не затронет ноль строк; `$1` — размер порции (по умолчанию 1 000,
пауза 50 мс). Блокировки строк держатся одну порцию; отказ или отмена оставляют сделанные порции, следующий запуск
продолжает с места, если оператор выбирает только необработанные строки. С `no-transaction` не сочетается.

```sql
-- pg-migrate:phase=contract
ALTER TABLE items DROP COLUMN legacy_status
```

С `phase: 'expand'` (до выкатки кода) применяется всё до первой ожидающей contract-миграции, остальное
откладывается (`report.deferred`); с `phase: 'contract'` (после выкатки) — отказ, если перед ней есть
неприменённые. Без `phase` фазы не учитываются.

### `planMigrations(client, options)` и `formatMigrationPlan(plan)`

План без применения для `deploy --plan`: шаги (в транзакции / вне / порциями), операторы и блокировка каждого
(`classifyStatementLock`: `CREATE INDEX` — SHARE, останавливает запись; `CONCURRENTLY` — SHARE UPDATE EXCLUSIVE;
`ALTER TABLE` — ACCESS EXCLUSIVE; незнакомое — «не классифицировано», а не «безопасно»), отложенные contract-миграции.
Только чтение журнала, без лока.

### `detectSchemaDrift(client, { migrationsFolder, schema?, ignoreTables?, migrationsSchema?, migrationsTable? })`

Живая база против снимка drizzle-kit (`meta/<idx>_snapshot.json`) последней ПРИМЕНЁННОЙ миграции каталога:
недостающие и лишние таблицы, колонки, индексы и ограничения; тип колонки (после нормализации синонимов), NOT NULL,
наличие DEFAULT, уникальность индекса, INVALID-индексы. Возвращает `SchemaDrift[]` (`{ kind, object, expected?,
actual? }`). Пределы: DEFAULT сравнивается наличием, а не выражением; ограничения — по именам (первичный ключ — по
колонкам), не по определению; таблица журнала не в счёт.

<!-- example: examples/plan-and-drift.ts -->
```ts
import { detectSchemaDrift, formatMigrationPlan, planMigrations } from '@hoshinotatsuya/pg-migrate';
import type { Client } from 'pg';

/** `deploy --plan`: what would run and which locks each statement takes. Reads the journal only. */
export async function printPlan(client: Client, migrationsFolder: string): Promise<void> {
  const plan = await planMigrations(client, { migrationsFolder, phase: 'expand' });
  for (const line of formatMigrationPlan(plan)) {
    console.log(line);
  }
  for (const step of plan.steps) {
    for (const migration of step.migrations) {
      if (migration.statements.some((statement) => statement.lock.blocksWrites)) {
        console.warn(`${migration.tag} blocks writes while it runs`);
      }
    }
  }
}

/** After deploy: the live database against the drizzle-kit snapshot of the last applied migration. */
export async function assertNoDrift(client: Client, migrationsFolder: string): Promise<void> {
  const drift = await detectSchemaDrift(client, { migrationsFolder });
  if (drift.length > 0) {
    throw new Error(drift.map((item) => `${item.kind} ${item.object}`).join('\n'));
  }
}
```

### `runMigrationsForSchemas(client, { schemas, continueOnError?, ...MigrateOptions })`

Те же миграции в каждой схеме (схема на арендатора): журнал — в ней же, `search_path` — она на время её миграций.
Возвращает `SchemaRunReport[]` (`applied` / `failed` / `not-started`); отказ — `MultiSchemaMigrationError` со всеми
отчётами. Без `continueOnError` обход останавливается на первом отказе; `signal` останавливает его всегда. Схема,
которую одновременно создаёт другой мигратор, — не отказ.

<!-- example: examples/schema-per-tenant.ts -->
```ts
import { MultiSchemaMigrationError, runMigrationsForSchemas } from '@hoshinotatsuya/pg-migrate';
import type { Client } from 'pg';

/** The same migrations in every tenant schema; each schema keeps its own journal. */
export async function migrateTenants(client: Client, migrationsFolder: string, tenants: readonly string[]) {
  try {
    const reports = await runMigrationsForSchemas(client, {
      schemas: tenants.map((tenant) => `tenant_${tenant}`),
      lockKey: 'billing:tenant-migrations',
      migrationsFolder,
      log: console.log,
      continueOnError: true, // try every schema, then report all failures at once
    });
    return reports.map((report) => `${report.schema}: ${report.status}`);
  } catch (error) {
    if (error instanceof MultiSchemaMigrationError) {
      // error.reports: { schema, status: 'applied' | 'failed' | 'not-started', report?, error? }[]
    }
    throw error;
  }
}
```

### `connectWithRetry(config, deadlineMs, intervalMs, log, { signal? })` → `Promise<pg.Client>`

Подключение с повторами до `deadlineMs` (база может ещё подниматься). Каждая попытка ограничена остатком времени
(хост, молча роняющий пакеты, иначе держал бы одну попытку до таймаута TCP ОС), попытка при остатке меньше
`MIGRATE_DEFAULTS.MIN_CONNECT_ATTEMPT_MS` (1 с) не начинается, `signal` прерывает и паузу, и идущую попытку. У
возвращённого клиента стоит обработчик `'error'`: разрыв сервером пишется в журнал, а не роняет процесс.

### Строительные блоки

`refuseInvalidIndexes(client, log, schema?)`, `refuseSkippedMigrations(client, log, migrationsFolder, journal)`,
`migrationFailure(error, lockTimeoutMs?)` (читаемая ошибка: сообщение, detail, hint Postgres, упавшая миграция и вид
шага, а на 55P03 — кто держит блокировку и безопасен ли повтор), `classifyStatementLock(statement)`.

### Ошибки, константы и типы

Тексты ошибок сейчас на русском; сверяйте класс и поля.

| Класс | Когда | Поля |
|---|---|---|
| `MigrationStepError` | упал шаг (в транзакции, вне её или порционный) | `tags`, `kind` (`STEP_KIND`), `leftInvalidIndexes`, `cause` |
| `MultiSchemaMigrationError` | упала одна или несколько схем `runMigrationsForSchemas` | `reports` |
| `Error` | потолок ожидания лока, INVALID-индекс, пропущенная миграция, неверный заголовок или опция, лок держит не эта сессия, хук оставил транзакцию — по возможности до любых изменений | текст с причиной и командой исправления |

Константы (заморожены глубоко): `MIGRATE_DEFAULTS`, `LOCK_KEY_HASH`, `MIGRATION_DIRECTIVE`, `MIGRATION_PHASE`,
`NO_TRANSACTION_MARKER`, `POSTGRES_ERROR_CODE`, `POSTGRES_LIMIT`, `STEP_KIND`, `TIMER_LIMIT`. Типы: `MigrateOptions`,
`MigrationReport`, `StepReport`, `StepKind`, `MigrationPhase`, `MigrationPlan`, `PlanOptions`, `StatementLock`,
`SchemaDrift`, `DriftOptions`, `MultiSchemaOptions`, `SchemaRunReport`, `InvalidIndex`, `LockKeyHash`.

## Гарантии и пределы

Гарантируется:

- миграции по одному `lockKey` в каждый момент выполняет не больше одного мигратора и только пока лок держит эта
  сессия;
- при INVALID-индексах, пропускаемой миграции или неверных заголовках ничего не меняется;
- миграция записывается применённой только после успеха её операторов и без оставленного INVALID-индекса;
- лок и параметры сессии снимаются на любом выходе; наружу — исходный отказ.

Пределы:

- мигратору нужна одна сессия: пулеры в transaction mode (PgBouncer, Supavisor, RDS Proxy с мультиплексированием) не
  годятся;
- идущую миграцию drizzle `signal` не прерывает — закройте соединение, и сервер её откатит;
- шаги вне транзакции и порционные не атомарны: пишите их повторяемыми;
- сверка схемы сравнивает наличие DEFAULT (не выражение) и ограничения по именам;
- ключи `hashtext` — 32 бита: на базе, которую делят много приложений, лучше `lockKeyHash: 'int8'`.

## Совместимость

- Node.js ≥ 24.
- Postgres 15, 16, 17, 18.
- drizzle-orm `>=0.45.2 <0.46` (формат журнала drizzle-kit этой линии), pg `^8.18.0`.

## Поведение при отказе

Закрыт по умолчанию и, где возможно, до любых изменений: незнакомая директива заголовка, нецифровой параметр, пустой
ключ лока, неверные опции времени, INVALID-индекс, пропущенная или неупорядоченная миграция, лок у чужой сессии, хук,
оставивший транзакцию, — каждое это отказ с причиной, а не предупреждение. Незнакомый оператор классификация
блокировок называет «не классифицировано», а не «безопасно».

## Тесты и разработка

```sh
pnpm install
pnpm test        # поднимает postgres:17 в docker, гонит набор группами
pnpm typecheck   # исходники и examples/
pnpm lint
pnpm build
```

`pnpm test` нужен Docker (`scripts/with-postgres.sh`; задан `PG_TEST_URL` с адресом суперпользователя — docker не
нужен; `PG_TEST_IMAGE` — другой образ). Jest идёт через `jest-groups`: группы не больше 300 тестов, не больше двух
воркеров, строго одна за другой; пропущенные тесты — отказ. Каждый тест — в своей базе с синтетическими миграциями в
формате drizzle-kit; журнал, шаги вне транзакции, лок и уборка проверяются и под ролью владельца базы без суперправ.

## Лицензия

[MIT](LICENSE) © 2026 Hoshino Tatsuya
