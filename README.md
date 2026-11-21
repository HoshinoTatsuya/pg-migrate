# @hoshinotatsuya/pg-migrate

[![npm](https://img.shields.io/npm/v/@hoshinotatsuya/pg-migrate.svg)](https://www.npmjs.com/package/@hoshinotatsuya/pg-migrate)
[![CI](https://github.com/HoshinoTatsuya/pg-migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/HoshinoTatsuya/pg-migrate/actions/workflows/ci.yml)

[Русская версия](README.ru.md) · [Changelog](CHANGELOG.md)

A deploy-time runner for [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) migrations on Postgres that
refuses to do the dangerous thing quietly.

drizzle-orm's `migrate()` is fine on a laptop. In a deployment it meets two replicas starting at once, a long
transaction holding a table, a failed `CREATE INDEX CONCURRENTLY`, a migration branch merged after a newer one, and
a pod killed mid-run. This package runs the same migrations (same folder, same journal, same hashes) with:

| Problem | What the package does |
|---|---|
| two migrators at once | a session advisory lock; the second waits with a ceiling (`lockWaitMs`) and logs who holds the lock every 30 s |
| a migration waits forever behind a long transaction and blocks every query queued behind it | `lock_timeout` (5 s) set **after** the lock is taken; optional retry on 55P03 |
| an INVALID index left by a failed `CREATE INDEX CONCURRENTLY` | refusal before any change, with the exact `REINDEX`/`DROP` command |
| drizzle silently skips a migration whose timestamp is older than the last applied one | refusal with the names of such migrations |
| `CREATE INDEX CONCURRENTLY` cannot run in a transaction (drizzle runs everything in one) | `-- pg-migrate:no-transaction` header: statement by statement in autocommit, recorded in the journal as drizzle would |
| a backfill `UPDATE` locks the whole table | `-- pg-migrate:batched`: repeated in chunks until zero rows |
| new code needs the old schema during rollout | expand/contract phases |
| "Failed query: …" without the reason | the Postgres message, `detail` and `hint` in the error text |
| a dead pod's session or a server break crashes or hangs the deploy | `signal`, `'error'` listener, cleanup that never hides the original failure |

Plus a read-only plan with the lock each statement takes, a schema drift check against drizzle-kit snapshots, and a
schema-per-tenant runner.

## Install

```sh
pnpm add @hoshinotatsuya/pg-migrate drizzle-orm pg
pnpm add -D drizzle-kit @types/pg
```

Peer dependencies: `drizzle-orm >=0.45.2 <0.46`, `pg ^8.18.0`, optionally `@types/pg >=8.15.0`. Migrations are the
ordinary drizzle-kit output folder (`meta/_journal.json`, `*.sql`, `meta/*_snapshot.json`). CommonJS package with
type declarations.

## Quick start

<!-- the code below is examples/quick-start.ts, type-checked and run against Postgres in the test suite -->
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

Call it from the deploy step that runs before the new version starts (Kubernetes init container or job, release
phase, CI step). Connect **directly to Postgres** or through a pooler in **session mode**: the advisory lock and
`lock_timeout` are session-level, and in transaction mode they would end up on different server connections
(the package detects that and refuses).

Before switching an existing project from a migrator without these checks, look for INVALID indexes once — the
first deploy will refuse on them:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

## API

### `runMigrations(client, options)` → `Promise<MigrationReport>`

Order inside: advisory lock (`pg_try_advisory_lock` in a loop, ceiling `lockWaitMs`) → `lock_timeout` → refusal
on INVALID indexes and skipped migrations → `beforeMigrate` → migrations → INVALID check after applying →
`afterMigrate` → in `finally`: roll back a transaction a hook left, `RESET` the session settings, release the lock
(each cleanup step is attempted even if the previous one failed, and a cleanup failure never replaces the original
error). The report: `steps` (`{ tags, kind, durationMs, rows?, batches? }`), `deferred` (contract migrations
postponed in the `expand` phase), `durationMs`.

`client` is a connected `pg.Client` (not a pool — one session for the whole run). Options (`MigrateOptions`;
defaults in `MIGRATE_DEFAULTS`):

| Option | Default | Meaning |
|---|---|---|
| `lockKey` | required | advisory lock key, e.g. `'<app>:schema-migrations'`; one per application sharing the database. Empty or with surrounding spaces — refused |
| `migrationsFolder` | required | drizzle-kit output folder |
| `log` | required | `(line) => void` for progress, waits and warnings |
| `lockTimeoutMs` | 5 000 | `lock_timeout` of migration statements, set after the lock |
| `lockWaitMs` | 900 000 (15 min) | ceiling on waiting for the advisory lock; then a refusal naming the holder |
| `lockPollMs` | 2 000 | lock poll interval (`> 0`, ≤ 2³¹−1) |
| `lockKeyHash` | `'hashtext'` | `LOCK_KEY_HASH.hashtext` (32 bits) or `.int8` (first 64 bits of md5). Switching changes the lock: switch when no old migrator runs |
| `migrationsSchema`, `migrationsTable` | `drizzle`, `__drizzle_migrations` | the drizzle journal. The default journal is shared by every application of the database that did not set its own — and drizzle applies only migrations newer than the journal's last row: give each application its own |
| `schema` | `public` | schema checked for INVALID indexes (does **not** move the journal) |
| `invalidIndexSchemas` | — | more schemas to check for INVALID indexes |
| `beforeMigrate`, `afterMigrate` | — | `(client) => Promise<void>` under the lock, before/after migrations (baseline adoption, catalog checks). A hook that leaves an open or aborted transaction is a refusal |
| `signal` | — | aborts waiting for the lock and prevents migrations from starting; a running drizzle migration is not interrupted (closing the connection makes the server roll it back) |
| `statementTimeoutMs`, `idleInTransactionTimeoutMs` | not set | session ceilings for the run, reset afterwards |
| `lockTimeoutRetry` | off | `{ attempts, backoffMs }`: retry steps refused by `lock_timeout` (55P03); pause `backoffMs × 2^(attempt−1)` with jitter |
| `noTransactionLockTimeoutMs` | 600 000 (10 min) | `lock_timeout` of non-transactional steps (`CREATE INDEX CONCURRENTLY` waits for every older writer and snapshot) |
| `cleanupInvalidIndexes` | `false` | drop INVALID indexes a failed non-transactional step created, so a retry can rebuild them |
| `transactionPerMigration` | `false` | one transaction per migration instead of one for all pending (an early `ACCESS EXCLUSIVE` is not held through a late backfill) |
| `phase` | — | `MIGRATION_PHASE.expand` / `.contract` (below) |
| `slowMigrationMs` | 60 000 | a step slower than this gets a warning line |

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

### Migration file headers

Lines starting with `-- pg-migrate:` at the very top of a `.sql` file (`MIGRATION_DIRECTIVE`). An unknown
directive or parameter is a refusal naming the file — a typo must not silently run a backfill as one `UPDATE`.

```sql
-- pg-migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS items_status_idx ON items (status)
```

Runs outside a transaction, statement by statement (one statement per `--> statement-breakpoint` block), then
records the migration in the drizzle journal. Every statement must be repeatable (`IF NOT EXISTS`): a failure
leaves the finished statements in place without a journal row, and the next deploy runs the file again. An index
left INVALID is refused before the next run and is never recorded as applied.

```sql
-- pg-migrate:batched batch=5000 pause=20
UPDATE items SET status = 'new' WHERE id IN (SELECT id FROM items WHERE status IS NULL ORDER BY id LIMIT $1)
```

Each statement is repeated in autocommit until it affects zero rows; `$1` is the batch size (default 1 000, pause
50 ms). Row locks are held for one batch; a failure or cancellation keeps finished batches, and the next run
continues if the statement selects only unprocessed rows. Cannot be combined with `no-transaction`.

```sql
-- pg-migrate:phase=contract
ALTER TABLE items DROP COLUMN legacy_status
```

With `phase: 'expand'` (before the new code is rolled out) everything up to the first pending contract migration is
applied and the rest is deferred (`report.deferred`); with `phase: 'contract'` (after the rollout) a refusal if
earlier migrations are still pending. Without `phase`, phases are ignored.

### `planMigrations(client, options)` and `formatMigrationPlan(plan)`

A read-only plan for `deploy --plan`: steps (in a transaction / outside / batched), statements and the lock each
statement takes (`classifyStatementLock`: `CREATE INDEX` — SHARE, blocks writes; `CONCURRENTLY` — SHARE UPDATE
EXCLUSIVE; `ALTER TABLE` — ACCESS EXCLUSIVE; unknown — "not classified", never "safe"), deferred contract
migrations. Reads the journal only, takes no lock.

### `detectSchemaDrift(client, { migrationsFolder, schema?, ignoreTables?, migrationsSchema?, migrationsTable? })`

Compares the live database with the drizzle-kit snapshot (`meta/<idx>_snapshot.json`) of the last **applied**
migration of the folder: missing/extra tables, columns, indexes and constraints; column type (after normalising
synonyms), NOT NULL, presence of a DEFAULT, index uniqueness, INVALID indexes. Returns `SchemaDrift[]`
(`{ kind, object, expected?, actual? }`). Limits: a DEFAULT is compared by presence, not expression; constraints by
name (the primary key by columns), not by definition; the journal table is ignored.

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

The same migrations in each schema (schema per tenant), with the journal in that schema and `search_path` set to it
for its migrations. Returns `SchemaRunReport[]` (`applied` / `failed` / `not-started`); a failure is
`MultiSchemaMigrationError` with all reports. Without `continueOnError` the walk stops at the first failure;
`signal` always stops it. A schema created concurrently by another migrator is not a failure.

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

Connects with retries until `deadlineMs` (the database may still be starting). Each attempt is bounded by the
remaining time (a host that drops packets would otherwise hold one attempt for the OS TCP timeout), an attempt with
less than `MIGRATE_DEFAULTS.MIN_CONNECT_ATTEMPT_MS` (1 s) left is not started, and `signal` aborts both the pause and
the running attempt. The returned client has an `'error'` listener that logs a server-side break instead of
crashing the process.

### Building blocks

`refuseInvalidIndexes(client, log, schema?)`, `refuseSkippedMigrations(client, log, migrationsFolder, journal)`,
`migrationFailure(error, lockTimeoutMs?)` (the readable error: Postgres message, detail, hint, the failed migration
and step kind, and for 55P03 who holds the lock and whether a retry is safe), `classifyStatementLock(statement)`.

### Errors, constants and types

Error messages are currently written in Russian; match on classes and fields.

| Class | When | Fields |
|---|---|---|
| `MigrationStepError` | a step failed (transactional, non-transactional or batched) | `tags`, `kind` (`STEP_KIND`), `leftInvalidIndexes`, `cause` |
| `MultiSchemaMigrationError` | one or more schemas of `runMigrationsForSchemas` failed | `reports` |
| `Error` | lock wait ceiling, INVALID index, skipped migration, invalid header or option, lock not held by this session, hook left a transaction — all before any change where possible | message with the reason and the command to fix it |

Constants (deep-frozen): `MIGRATE_DEFAULTS`, `LOCK_KEY_HASH`, `MIGRATION_DIRECTIVE`, `MIGRATION_PHASE`,
`NO_TRANSACTION_MARKER`, `POSTGRES_ERROR_CODE`, `POSTGRES_LIMIT`, `STEP_KIND`, `TIMER_LIMIT`. Types: `MigrateOptions`,
`MigrationReport`, `StepReport`, `StepKind`, `MigrationPhase`, `MigrationPlan`, `PlanOptions`, `StatementLock`,
`SchemaDrift`, `DriftOptions`, `MultiSchemaOptions`, `SchemaRunReport`, `InvalidIndex`, `LockKeyHash`.

## Guarantees & limits

Guaranteed:

- at most one migrator per `lockKey` runs migrations at a time, and only while this session holds the lock;
- nothing is changed when the database has INVALID indexes, a migration would be skipped, or the headers are
  invalid;
- a migration is recorded as applied only after its statements succeeded and no INVALID index was left behind;
- the lock and session settings are released on every exit path; the original failure is what you get.

Limits:

- the runner needs one session: no transaction-mode poolers (PgBouncer, Supavisor, RDS Proxy multiplexing);
- a running drizzle migration is not cancelled by `signal` — close the connection to make the server roll it back;
- non-transactional and batched steps are not atomic: write them repeatable;
- drift detection compares DEFAULT presence (not expressions) and constraints by name;
- `hashtext` keys are 32-bit: on a database shared by many applications prefer `lockKeyHash: 'int8'`.

## Compatibility

- Node.js ≥ 24.
- Postgres 15, 16, 17, 18.
- drizzle-orm `>=0.45.2 <0.46` (journal format of drizzle-kit for that line), pg `^8.18.0`.

## Failure behavior

Fails closed, before changing anything whenever possible: an unknown header directive, a non-digit parameter, an
empty lock key, invalid timing options, an INVALID index, a skipped or out-of-order migration, a lock held by another
session, a hook that left a transaction — each is a refusal with the reason, not a warning. Lock
classification that does not recognise a statement says "not classified" rather than "safe".

## Testing & development

```sh
pnpm install
pnpm test        # starts postgres:17 in docker, runs the suite in groups
pnpm typecheck   # sources and examples/
pnpm lint
pnpm build
```

`pnpm test` needs Docker (`scripts/with-postgres.sh`; with `PG_TEST_URL` set to a superuser URL no Docker is
started; `PG_TEST_IMAGE` selects another image). Jest runs through `jest-groups`: groups of at most 300 tests, at
most two workers, strictly one after another; skipped tests fail the run. Every test uses its own database with
synthetic drizzle-kit-format migrations; the journal, non-transactional steps, the lock and cleanup are also checked
under a database owner role without superuser rights.

## License

[MIT](LICENSE) © 2026 Hoshino Tatsuya
