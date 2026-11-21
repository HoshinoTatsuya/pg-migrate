# Changelog

All notable changes to `@hoshinotatsuya/pg-migrate` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/) with the pre-1.0 convention: a **minor** bump may break the API,
a **patch** bump never does. Every breaking release has a "Migration" subsection.

## [0.7.2] - 2026-11-21

### Changed

- First public release as `@hoshinotatsuya/pg-migrate`, MIT; documentation in English (`README.md`) and Russian
  (`README.ru.md`), this changelog; no functional changes.
- README code samples live in `examples/*.ts`: they are type-checked against the real API by `pnpm typecheck`,
  the README is checked to quote them verbatim, and the quick start and the per-tenant example run against a real
  Postgres in the test suite.
- Dev dependencies: `@hoshinotatsuya/arch-gates` 0.12.2, `@hoshinotatsuya/jest-groups` 0.7.2.
- CI moved to GitHub Actions (`ci.yml`: typecheck, lint, tests on Postgres 15–18, build; `release.yml`: npm
  trusted publishing on a `vX.Y.Z` tag).

## [0.7.1] - 2026-11-21

### Fixed

- Migrator failure texts are built without a bare `String()`: a failure without a prototype or with a throwing
  `toString` no longer hides the original cause behind a `TypeError`.

## [0.7.0] - 2026-11-17

Second external audit: every claim was re-checked by an executable probe; true claims fixed, false ones pinned by
tests.

### Fixed

- `detectSchemaDrift`: no false `column-type` for `numeric(p, s)`, array synonyms, precision of zoned types and
  `char` without length; **constraints are compared** (`missing-constraint`/`extra-constraint`: primary key by
  columns, UNIQUE, foreign keys and CHECK by name); an INVALID index with the expected name is `index-invalid`;
  `schema` option for snapshots without a schema; the snapshot is that of the last **applied** migration of the
  folder; names longer than 63 bytes are compared truncated, as Postgres stores them. **(breaking)** — three new
  `SchemaDrift.kind` values.
- `runMigrationsForSchemas`: two migrators creating the same new schema no longer fail (23505 on
  `pg_namespace`); cancellation with `continueOnError` stops the walk.
- Batched migrations: `$1` inside a comment or string is not a parameter.
- Every failure of a non-transactional or batched step is a `MigrationStepError` with tags and kind; a failing
  `DROP INDEX CONCURRENTLY` under `cleanupInvalidIndexes` no longer replaces the step's failure.
- `beforeMigrate` leaving a transaction open or aborted is refused before migrations. **(breaking)**
- The lock holder is looked up in the current database only; the 55P03 hint of a non-transactional step names its
  own ceiling; a new migration with the same `when` as an applied one is refused as skipped.
- Stricter migration header **(breaking)**: `no-transaction` with `batched` is refused; parameter values are
  decimal digits only; `pause` above 2³¹−1 ms is refused.
- Compound `ALTER TABLE t a, b` is classified per action (strongest lock wins); string contents no longer affect
  lock classification.
- `connectWithRetry`: cancellation also aborts the running attempt.

### Migration

Handle the new `SchemaDrift.kind` values; remove `no-transaction` + `batched` pairs and non-digit parameter values
from headers; `beforeMigrate` must finish its own transactions.

## [0.6.1] - 2026-11-15

### Fixed

- The line about a `_ccnew`/`_ccold` leftover index is printed once per run.

## [0.6.0] - 2026-11-15

### Fixed

- A `lock_timeout` retry no longer records an INVALID index as applied: INVALID indexes are checked before every
  journal write of a non-transactional step, before each retry and after applying; a step that left an INVALID
  index is not retried unless `cleanupInvalidIndexes` removes it.
- Own lock ceiling for non-transactional steps: `noTransactionLockTimeoutMs` (default 10 min).
- Honest 55P03 hints per step kind; an `'error'` listener on the migrator client (a server-side session break no
  longer crashes the deploy process).

### Added

- `transactionPerMigration`; refusal on unordered `when` values when migrations run in steps; skipped-migration
  check repeated after `beforeMigrate`; no temporary directory (works with a read-only root filesystem);
  `connectWithRetry` minimum attempt time.
- Batched backfills (`-- pg-migrate:batched [batch=1000] [pause=50]`), expand/contract phases
  (`-- pg-migrate:phase=contract` and the `phase` option), strict migration headers (`MIGRATION_DIRECTIVE`),
  `planMigrations` + `formatMigrationPlan` + `classifyStatementLock`, `detectSchemaDrift`,
  `runMigrationsForSchemas`, `MigrationReport` with step durations and `slowMigrationMs`.

### Migration

- `runMigrations` returns a report instead of `undefined`.
- Non-transactional steps wait for locks up to `noTransactionLockTimeoutMs` (10 min): give the deploy job a longer
  ceiling or lower the option.
- A file whose first line starts with `-- pg-migrate:` but is not a known directive is refused; unordered `when`
  values in a folder with a marked migration are refused before any change.

## [0.5.0] - 2026-11-15

### Changed

- `exports` map: files outside the declared entry points can no longer be imported; exported dictionaries are
  deep-frozen.

## [0.4.0] - 2026-11-15

### Added

- Non-transactional migrations for `CREATE INDEX CONCURRENTLY`: a file whose first line is
  `-- pg-migrate:no-transaction` (`NO_TRANSACTION_MARKER`) runs statement by statement in autocommit and is then
  recorded in the drizzle journal with the same hash and timestamp drizzle would write.
- Refusal when the migration lock is not held by this session (transaction-mode pooler).
- `lockTimeoutRetry: { attempts, backoffMs }`, `invalidIndexSchemas`.

## [0.3.2] - 2026-11-14

### Added

- `refuseSkippedMigrations`: refusal on a migration drizzle would silently skip (its `when` is older than the last
  applied one); an edited applied migration is a log line, not a refusal.

## [0.3.0] - 2026-11-14

### Fixed

- Session cleanup after a hook that left a transaction (25P02): the transaction is rolled back first, then
  `RESET` and unlock; every cleanup step is attempted.
- `lockPollMs`, `connectWithRetry` deadline and interval are validated.
- `schema` does not move the journal (documented; a log line when `schema` is set without `migrationsSchema`).

## [0.2.0] - 2026-11-14

### Added

- `signal`, attempt time bounded by the remaining deadline in `connectWithRetry`, 64-bit lock keys
  (`lockKeyHash: 'int8'`), journal schema and table, session ceilings `statementTimeoutMs` and
  `idleInTransactionTimeoutMs`, REINDEX/DROP hints with schema and quoting.

## [0.1.3] - 2026-11-14

### Fixed

- Waiting for the advisory lock has a ceiling (`lockWaitMs`, 15 min) and reports the holder every 30 s.
- Cleanup no longer replaces the original failure; `lockKey` with surrounding spaces is refused.

## [0.1.1] – [0.1.2] - 2026-11-10

### Added

- `runMigrations` under an advisory lock with `lock_timeout` after the lock, refusal on INVALID indexes before any
  change, Postgres message/detail/hint in the failure (`migrationFailure`), `connectWithRetry`.
