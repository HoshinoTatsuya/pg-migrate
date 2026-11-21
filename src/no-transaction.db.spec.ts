import type { Client } from 'pg';

import { NO_TRANSACTION_MARKER } from './constants/no-transaction-marker.constant';
import { runMigrations } from './run-migrations';
import { migratorDatabase } from './testing/migrator-database';
import { writeMigrations } from './testing/test-database';
import { waitUntil } from './testing/wait-until';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

const BASE = 1_700_000_000_000;
const TABLE = {
  tag: '0000_big',
  when: BASE,
  statements: [
    'CREATE TABLE big (id integer, name text)',
    "INSERT INTO big SELECT g, 'n' || (g % 10) FROM generate_series(1, 100) g",
    'CREATE TABLE dup (k integer)',
    'INSERT INTO dup VALUES (1), (1)',
  ],
};
const CIC = {
  tag: '0001_idx',
  when: BASE + 1000,
  statements: [
    `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS big_name_idx ON big (name)`,
  ],
};
const COLUMN = { tag: '0002_col', when: BASE + 2000, statements: ['ALTER TABLE big ADD COLUMN note text'] };

/**
 * `CREATE INDEX CONCURRENTLY` и INVALID-индексы на настоящем Postgres 17:
 * держатель-писатель (CIC ждёт конца каждой пишущей транзакции), держатель
 * старого снимка (REPEATABLE READ), повтор по lock_timeout с `IF NOT EXISTS`.
 */
describeDb('шаг вне транзакции: CIC, INVALID-индексы, свой потолок блокировок [нужен PG_TEST_URL]', () => {
  const harness = migratorDatabase(adminUrl);
  const { state, log, connect } = harness;

  const journalTags = async (client: Client): Promise<string[]> =>
    (
      await client.query<{ created_at: string }>(
        'SELECT created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at',
      )
    ).rows.map((row) => row.created_at);
  const indexValidity = async (client: Client, name: string): Promise<boolean | null> =>
    (
      await client.query<{ valid: boolean }>(
        'SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1',
        [name],
      )
    ).rows[0]?.valid ?? null;
  /** Миграция таблиц — отдельным запуском: дальше пишущий держатель держит уже существующую таблицу. */
  const withTable = async (client: Client, ...later: Array<typeof CIC>): Promise<void> => {
    state.folder = writeMigrations([TABLE]);
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    state.folder = writeMigrations([TABLE, ...later]);
  };
  const waitingOn = (client: Client, prefix: string) => async (): Promise<boolean> =>
    (
      await client.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND query LIKE $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
        [`%${prefix}%`],
      )
    ).rows.length > 0;

  it('писатель держит таблицу, CIC отказал по потолку, повтор включён — отказ с INVALID в тексте, в журнал не записано', async () => {
    const client = await connect();
    await withTable(client, CIC);
    const holder = await connect();
    await holder.query('BEGIN');
    await holder.query("INSERT INTO big VALUES (0, 'держатель')");
    try {
      const failure = await runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: state.folder,
        log,
        lockTimeoutMs: 300,
        noTransactionLockTimeoutMs: 300,
        lockTimeoutRetry: { attempts: 3, backoffMs: 10 },
      }).catch((error: unknown) => error as Error);
      // Прежде: попытка 2 с IF NOT EXISTS пропускала INVALID — «миграции применены».
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('оставлены INVALID-индексы: public.big_name_idx');
      expect((failure as Error).message).toContain('DROP INDEX CONCURRENTLY "public"."big_name_idx"');
      expect((failure as Error).message).toContain('вне транзакции');
      expect(await journalTags(client)).toEqual([String(BASE)]);
      expect(await indexValidity(client, 'big_name_idx')).toBe(false);
      expect(state.lines.some((line) => line.includes('попытка 1 из 3'))).toBe(false);
    } finally {
      await holder.query('ROLLBACK');
    }
  });

  it('cleanupInvalidIndexes: оставленный INVALID убран, повтор строит индекс целым и пишет журнал', async () => {
    const client = await connect();
    await withTable(client, CIC);
    const holder = await connect();
    await holder.query('BEGIN');
    await holder.query("INSERT INTO big VALUES (0, 'держатель')");
    const watcher = await connect();
    let released: Promise<unknown> | undefined;
    const release = (): Promise<unknown> => {
      released ??= holder.query('COMMIT');
      return released;
    };
    const releaseOnCleanup = (line: string): void => {
      log(line);
      if (line.includes('убран INVALID-индекс')) {
        void release();
      }
    };
    // Уборка (DROP INDEX CONCURRENTLY) ждёт того же писателя — он уходит, как только она его ждёт.
    const dropWaits = waitingOn(watcher, 'DROP INDEX CONCURRENTLY');
    const watching = waitUntil(
      'уборка ждёт писателя',
      async () => released !== undefined || (await dropWaits()),
      4_000,
    ).then(release, () => undefined);
    const report = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log: releaseOnCleanup,
      noTransactionLockTimeoutMs: 500,
      lockTimeoutRetry: { attempts: 5, backoffMs: 100 },
      cleanupInvalidIndexes: true,
    });
    await release();
    await watching;
    expect(report.steps.map((step) => step.tags)).toEqual([['0001_idx']]);
    expect(await indexValidity(client, 'big_name_idx')).toBe(true);
    expect(await journalTags(client)).toEqual([String(BASE), String(BASE + 1000)]);
    expect(
      state.lines.filter((line) => line.includes('убран INVALID-индекс "public"."big_name_idx"')),
    ).toHaveLength(1);
    expect(
      state.lines.some((line) => line.includes('попытка 1 из 5') && line.includes('вне транзакции')),
    ).toBe(true);
  });

  it('свой потолок шага вне транзакции: писатель старше lockTimeoutMs — CIC ждёт его и проходит', async () => {
    const client = await connect();
    await withTable(client, CIC);
    const holder = await connect();
    await holder.query('BEGIN');
    await holder.query("INSERT INTO big VALUES (0, 'держатель')");
    const watcher = await connect();
    // Писатель уходит через 600 мс после того, как CIC начал его ждать: втрое дольше lockTimeoutMs.
    const released = waitUntil('CIC ждёт писателя', waitingOn(watcher, 'CREATE INDEX CONCURRENTLY'))
      .then(() => new Promise((resolve) => setTimeout(resolve, 600)))
      .finally(() => holder.query('COMMIT'));
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log, lockTimeoutMs: 200 });
    await released;
    expect(await indexValidity(client, 'big_name_idx')).toBe(true);
    // Потолок сессии после шага — снова lockTimeoutMs, и сброшен в конце.
    expect((await client.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
  });

  it('держатель старого снимка (REPEATABLE READ) — CIC ждёт его под lock_timeout: под коротким потолком 55P03', async () => {
    const client = await connect();
    await withTable(client, CIC);
    const holder = await connect();
    await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await holder.query('SELECT count(*) FROM dup');
    try {
      const failure = await runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: state.folder,
        log,
        noTransactionLockTimeoutMs: 300,
      }).catch((error: unknown) => error as Error);
      expect((failure as Error).message).toContain('canceling statement due to lock timeout');
      expect(await indexValidity(client, 'big_name_idx')).toBe(false);
    } finally {
      await holder.query('ROLLBACK');
    }
  });

  it('INVALID с тем же именем появился до шага: IF NOT EXISTS его пропустил — в журнал не записано', async () => {
    const client = await connect();
    await withTable(client, CIC);
    const failure = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      // После проверки до миграций: недостроенный индекс с именем из миграции (повтор, чужая операция).
      beforeMigrate: async (session) => {
        await session
          .query('CREATE UNIQUE INDEX CONCURRENTLY big_name_idx ON big (name)')
          .catch(() => undefined);
      },
    }).catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain('в журнал не записана');
    expect(await journalTags(client)).toEqual([String(BASE)]);
  });

  it('INVALID появился во время запуска, ожидали только транзакционные миграции — отказ проверкой ПОСЛЕ применения', async () => {
    const client = await connect();
    await withTable(client, COLUMN);
    await expect(
      runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: state.folder,
        log,
        beforeMigrate: async (session) => {
          await session
            .query('CREATE UNIQUE INDEX CONCURRENTLY dup_k_uidx ON dup (k)')
            .catch(() => undefined);
        },
      }),
    ).rejects.toThrow('INVALID-индексы в схеме public: dup_k_uidx');
  });

  it('INVALID появился в паузе повтора — проверка перед повтором: миграция не применена', async () => {
    const client = await connect();
    await withTable(client, COLUMN);
    const holder = await connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE big IN ACCESS SHARE MODE');
    const breaker = await connect();
    // Пауза повтора — ровно backoffMs: INVALID успевает появиться до проверки перед повтором.
    jest.spyOn(Math, 'random').mockReturnValue(1);
    let broke: Promise<unknown> | undefined;
    const onLine = (line: string): void => {
      log(line);
      if (line.includes('попытка 1 из')) {
        broke = breaker
          .query('CREATE UNIQUE INDEX CONCURRENTLY dup_k_uidx ON dup (k)')
          .catch(() => undefined)
          .then(() => holder.query('ROLLBACK'));
      }
    };
    const failure = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log: onLine,
      lockTimeoutMs: 100,
      lockTimeoutRetry: { attempts: 5, backoffMs: 1_000 },
    }).catch((error: unknown) => error as Error);
    await broke;
    expect((failure as Error).message).toContain('dup_k_uidx');
    const note = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'big' AND column_name = 'note'",
    );
    // Без проверки перед повтором ALTER прошёл бы, и отказ пришёл бы уже после применения.
    expect(note.rows[0].n).toBe(0);
  });
});
