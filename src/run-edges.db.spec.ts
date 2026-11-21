import { Client } from 'pg';

import { NO_TRANSACTION_MARKER } from './constants/no-transaction-marker.constant';
import { MultiSchemaMigrationError } from './multi-schema-migration.error';
import { runMigrations } from './run-migrations';
import { runMigrationsForSchemas } from './run-migrations-for-schemas';
import { migratorDatabase } from './testing/migrator-database';
import { createTestDatabase, writeMigrations } from './testing/test-database';
import { waitUntil } from './testing/wait-until';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

jest.setTimeout(30_000);

const BASE = 1_700_000_000_000;
/** Вызов прошёл там, где ждали отказ: проверка ниже упадёт на тексте этой ошибки. */
const passed = (): Error => new Error('ожидался отказ, а вызов прошёл');
const TABLE = {
  tag: '0000_big',
  when: BASE,
  statements: ['CREATE TABLE big (id integer, name text, done boolean NOT NULL DEFAULT false)'],
};
const CIC = {
  tag: '0001_idx',
  when: BASE + 1000,
  statements: [
    `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS big_name_idx ON big (name)`,
  ],
};

/**
 * Запуск мигратора на краевых случаях: гонка создания схемы, `$1` в
 * комментарии порционной миграции, отказ записи журнала и уборки INVALID,
 * транзакция, оставленная хуком, держатель лока в другой базе, подсказка
 * потолка шага вне транзакции, отмена обхода схем, две миграции с одной меткой.
 */
describeDb('runMigrations: краевые случаи [нужен PG_TEST_URL]', () => {
  const { state, log, connect } = migratorDatabase(adminUrl);

  const exists = async (client: Client, name: string): Promise<boolean> =>
    (await client.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [name])).rows[0]?.t !==
    null;
  const waitingOn = (client: Client, prefix: string) => async (): Promise<boolean> =>
    (
      await client.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND query LIKE $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
        [`%${prefix}%`],
      )
    ).rows.length > 0;

  it('два мигратора одновременно создают новую схему — второй не падает 23505, миграции применены', async () => {
    state.folder = writeMigrations([
      { tag: '0000_t', when: BASE, statements: ['CREATE TABLE notes (id integer)'] },
    ]);
    const first = await connect();
    const second = await connect();
    const watcher = await connect();
    await first.query('BEGIN');
    await first.query('CREATE SCHEMA IF NOT EXISTS tenant_race');
    const running = runMigrationsForSchemas(second, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      schemas: ['tenant_race'],
    }).catch((error: unknown) => error);
    await waitUntil('второй ждёт схему', waitingOn(watcher, 'CREATE SCHEMA'), 5_000);
    await first.query('COMMIT');
    const outcome = await running;
    const reports = (
      outcome instanceof MultiSchemaMigrationError ? outcome.reports : outcome
    ) as ReadonlyArray<{
      status: string;
      error?: unknown;
    }>;
    // Прежде: [['failed', '23505']] — unique_violation индекса каталога pg_namespace.
    expect(
      reports.map((report) => [report.status, (report.error as { code?: unknown } | undefined)?.code]),
    ).toEqual([['applied', undefined]]);
    expect(await exists(second, 'tenant_race.notes')).toBe(true);
  });

  it('порционная миграция: $1 в комментарии и строке — не параметр (без 08P01), бэкфилл выполнен', async () => {
    state.folder = writeMigrations([TABLE]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    await client.query('INSERT INTO big (id) SELECT g FROM generate_series(1, 7) g');
    state.folder = writeMigrations([
      TABLE,
      {
        tag: '0001_fill',
        when: BASE + 1000,
        statements: [
          "-- pg-migrate:batched pause=0\nUPDATE big SET done = true, name = 'стоимость $1' WHERE id IN (SELECT id FROM big WHERE NOT done LIMIT 3) -- порция зашита, не $1",
        ],
      },
    ]);
    const report = await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(report.steps.map((step) => [step.tags, step.batches])).toEqual([[['0001_fill'], 4]]);
    expect((await client.query('SELECT count(*)::int AS n FROM big WHERE NOT done')).rows[0].n).toBe(0);
  });

  it('отказ записи в журнал после шага вне транзакции и порционного — отказ шага с тегом, а не сырая ошибка', async () => {
    state.folder = writeMigrations([TABLE]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    await client.query(
      "CREATE FUNCTION drizzle.refuse() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'журнал недоступен'; END$$",
    );
    await client.query(
      'CREATE TRIGGER refuse BEFORE INSERT ON drizzle.__drizzle_migrations FOR EACH ROW EXECUTE FUNCTION drizzle.refuse()',
    );
    state.folder = writeMigrations([TABLE, CIC]);
    const outside = await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log }).then(
      passed,
      (error: unknown) => error as Error,
    );
    expect(outside.message).toContain('журнал недоступен');
    expect(outside.message).toContain('миграция: 0001_idx (вне транзакции)');
    state.folder = writeMigrations([
      TABLE,
      {
        tag: '0001_fill',
        when: BASE + 1000,
        statements: ['-- pg-migrate:batched\nUPDATE big SET done = true WHERE false'],
      },
    ]);
    const batched = await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log }).then(
      passed,
      (error: unknown) => error as Error,
    );
    expect(batched.message).toContain('миграция: 0001_fill (вне транзакции)');
  });

  it('cleanupInvalidIndexes: DROP INDEX CONCURRENTLY отказал — отказ шага с тегом и оставленным INVALID, без повтора', async () => {
    state.folder = writeMigrations([TABLE]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    state.folder = writeMigrations([TABLE, CIC]);
    const holder = await connect();
    await holder.query('BEGIN');
    await holder.query("INSERT INTO big VALUES (0, 'держатель')");
    try {
      const failure = await runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: state.folder,
        log,
        noTransactionLockTimeoutMs: 300,
        lockTimeoutRetry: { attempts: 3, backoffMs: 10 },
        cleanupInvalidIndexes: true,
      }).then(passed, (error: unknown) => error as Error);
      expect(failure.message).toContain('миграция: 0001_idx (вне транзакции)');
      expect(failure.message).toContain('оставлены INVALID-индексы: public.big_name_idx');
      expect(
        state.lines.some((line) => line.includes('INVALID-индекс "public"."big_name_idx" не убран')),
      ).toBe(true);
      expect(state.lines.some((line) => line.includes('попытка 1 из 3'))).toBe(false);
    } finally {
      await holder.query('ROLLBACK');
    }
  });

  it('beforeMigrate оставил транзакцию открытой — отказ до миграций, работа хука откатана', async () => {
    state.folder = writeMigrations([TABLE]);
    const client = await connect();
    await client.query('CREATE TABLE hook_log (x integer)');
    const failure = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      beforeMigrate: async (session) => {
        await session.query('BEGIN');
        await session.query('INSERT INTO hook_log VALUES (1)');
      },
    }).then(passed, (error: unknown) => error as Error);
    expect(failure.message).toContain('beforeMigrate оставил незавершённую транзакцию');
    expect(await exists(client, 'public.big')).toBe(false);
    expect((await client.query('SELECT count(*)::int AS n FROM hook_log')).rows[0].n).toBe(0);
  });

  it('держатель лока с тем же ключом в ДРУГОЙ базе в отказ не попадает: advisory-лок — в пределах базы', async () => {
    state.folder = writeMigrations([TABLE]);
    const other = await createTestDatabase(adminUrl as string);
    const foreign = new Client({ connectionString: other.url });
    await foreign.connect();
    try {
      await foreign.query("SELECT pg_advisory_lock(hashtext('k'))");
      const foreignPid = (await foreign.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid;
      const local = await connect();
      await local.query("SELECT pg_advisory_lock(hashtext('k'))");
      const localPid = (await local.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      const client = await connect();
      const failure = await runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: state.folder,
        log,
        lockWaitMs: 300,
        lockPollMs: 50,
      }).then(passed, (error: unknown) => error as Error);
      expect(failure.message).toContain(`держит pid ${localPid} `);
      expect(failure.message).not.toContain(`pid ${foreignPid} `);
    } finally {
      await foreign.end();
      await other.drop();
    }
  });

  it('подсказка 55P03 шага вне транзакции — его собственный потолок, а не общий lockTimeoutMs', async () => {
    state.folder = writeMigrations([TABLE]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    state.folder = writeMigrations([TABLE, CIC]);
    const holder = await connect();
    await holder.query('BEGIN');
    await holder.query("INSERT INTO big VALUES (0, 'держатель')");
    try {
      const failure = await runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: state.folder,
        log,
        lockTimeoutMs: 7_000,
        noTransactionLockTimeoutMs: 400,
        cleanupInvalidIndexes: true,
      }).then(passed, (error: unknown) => error as Error);
      expect(failure.message).toContain('ждала блокировку дольше 400 мс');
      expect(failure.message).not.toContain('7000 мс');
    } finally {
      await holder.query('ROLLBACK');
    }
  });

  it('отмена с continueOnError — обход схем останавливается: остальные не начаты и не созданы', async () => {
    state.folder = writeMigrations([
      { tag: '0000_t', when: BASE, statements: ['CREATE TABLE notes (id integer)'] },
    ]);
    const client = await connect();
    const controller = new AbortController();
    const failure = await runMigrationsForSchemas(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      schemas: ['tenant_x', 'tenant_y', 'tenant_z'],
      continueOnError: true,
      signal: controller.signal,
      beforeMigrate: async () => {
        controller.abort(new Error('деплой отменён'));
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MultiSchemaMigrationError);
    expect((failure as MultiSchemaMigrationError).reports.map((report) => report.status)).toEqual([
      'failed',
      'not-started',
      'not-started',
    ]);
    const schemas = await client.query<{ name: string }>(
      "SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'tenant\\_%' ORDER BY 1",
    );
    expect(schemas.rows.map((row) => row.name)).toEqual(['tenant_x']);
  });

  it('новая миграция с той же меткой when, что у применённой, — отказ как пропущенная, а не «отредактированная»', async () => {
    const FIRST = { tag: '0000_a', when: BASE, statements: ['CREATE TABLE a (x integer)'] };
    state.folder = writeMigrations([FIRST]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    state.folder = writeMigrations([
      FIRST,
      { tag: '0001_b', when: BASE, statements: ['CREATE TABLE b (x integer)'] },
    ]);
    const failure = await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log }).then(
      passed,
      (error: unknown) => error as Error,
    );
    expect(failure.message).toContain('0001_b');
    expect(failure.message).toContain('drizzle пропустил бы');
    // Двойник: тот же файл с правкой текста — строка в логе, не отказ.
    state.folder = writeMigrations([{ ...FIRST, statements: ['CREATE TABLE a (x integer, y text)'] }]);
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(state.lines.some((line) => line.includes('отредактированы после применения: 0000_a'))).toBe(true);
  });
});
