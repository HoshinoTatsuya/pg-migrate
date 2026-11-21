import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Client } from 'pg';

import { NO_TRANSACTION_MARKER } from './constants/no-transaction-marker.constant';
import { runMigrations } from './run-migrations';
import { migratorDatabase } from './testing/migrator-database';
import { writeMigrations } from './testing/test-database';
import { waitUntil } from './testing/wait-until';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

const BASE = 1_700_000_000_000;
const TABLE = { tag: '0000_t', when: BASE, statements: ['CREATE TABLE big (id integer, name text)'] };
const CIC = {
  tag: '0001_idx',
  when: BASE + 1000,
  statements: [
    `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS big_name_idx ON big (name)`,
  ],
};

/** Нарезка на шаги, транзакции, повторы, пометки и отчёт — на настоящем Postgres. */
describeDb('шаги применения [нужен PG_TEST_URL]', () => {
  const { state, log, connect } = migratorDatabase(adminUrl);

  const journal = async (client: Client): Promise<string[]> =>
    (
      await client.query<{ created_at: string }>(
        'SELECT created_at::text FROM drizzle.__drizzle_migrations ORDER BY id',
      )
    ).rows.map((row) => row.created_at);
  const exists = async (client: Client, name: string): Promise<boolean> =>
    (await client.query('SELECT to_regclass($1) AS t', [name])).rows[0].t !== null;

  it('обычная миграция в каталоге с помеченной идёт В ТРАНЗАКЦИИ: её отказ откатывает её целиком', async () => {
    state.folder = writeMigrations([
      TABLE,
      CIC,
      {
        tag: '0002_half',
        when: BASE + 2000,
        statements: ['CREATE TABLE half_done (x integer)', 'SELECT * FROM no_such_table'],
      },
    ]);
    const client = await connect();
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log }),
    ).rejects.toThrow('no_such_table');
    // Вне транзакции первый оператор остался бы: таблица была бы.
    expect(await exists(client, 'half_done')).toBe(false);
    expect(await journal(client)).toEqual([String(BASE), String(BASE + 1000)]);
  });

  it('повторный запуск после миграции вне транзакции, последней в журнале, — без повтора и без второй записи', async () => {
    state.folder = writeMigrations([TABLE, CIC]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    const second = await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(second.steps).toEqual([]);
    expect(await journal(client)).toEqual([String(BASE), String(BASE + 1000)]);
  });

  it('пустая база, первая же миграция помечена: журнал заведён, миграция записана', async () => {
    state.folder = writeMigrations([
      {
        tag: '0000_first',
        when: BASE,
        statements: [`${NO_TRANSACTION_MARKER}\nCREATE TABLE IF NOT EXISTS first_one (x integer)`],
      },
    ]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(await journal(client)).toEqual([String(BASE)]);
    expect(await exists(client, 'first_one')).toBe(true);
  });

  it('без записываемого tmpdir (readOnlyRootFilesystem) смешанный каталог применяется', async () => {
    state.folder = writeMigrations([
      TABLE,
      CIC,
      { tag: '0002_col', when: BASE + 2000, statements: ['ALTER TABLE big ADD COLUMN note text'] },
    ]);
    const client = await connect();
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = '/nonexistent-read-only-root';
    try {
      await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    } finally {
      process.env.TMPDIR = saved;
    }
    expect(await journal(client)).toEqual([String(BASE), String(BASE + 1000), String(BASE + 2000)]);
  });

  it('повторы по lock_timeout исчерпаны — отказ после ровно attempts попыток', async () => {
    state.folder = writeMigrations([TABLE]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    state.folder = writeMigrations([
      TABLE,
      { tag: '0001_col', when: BASE + 1000, statements: ['ALTER TABLE big ADD COLUMN note text'] },
    ]);
    const holder = await connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE big IN ACCESS SHARE MODE');
    try {
      await expect(
        runMigrations(client, {
          lockKey: 'k',
          migrationsFolder: state.folder,
          log,
          lockTimeoutMs: 50,
          lockTimeoutRetry: { attempts: 3, backoffMs: 0 },
        }),
      ).rejects.toThrow('canceling statement due to lock timeout');
      const retries = state.lines.filter((line) => line.includes('ждала блокировку'));
      expect(retries.map((line) => /попытка (\d) из 3/.exec(line)?.[1])).toEqual(['1', '2']);
      expect(retries.every((line) => line.includes('её транзакция откачена целиком'))).toBe(true);
    } finally {
      await holder.query('ROLLBACK');
    }
  });

  it('transactionPerMigration: ранняя миграция фиксируется до поздней — её блокировка не держится, отказ поздней её не откатывает', async () => {
    state.folder = writeMigrations([TABLE]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    const LATE = {
      tag: '0002_slow',
      when: BASE + 2000,
      statements: ['SELECT pg_sleep(0.8)', 'SELECT * FROM no_such_table'],
    };
    const EARLY = {
      tag: '0001_col',
      when: BASE + 1000,
      statements: ['ALTER TABLE big ADD COLUMN note text'],
    };
    state.folder = writeMigrations([TABLE, EARLY, LATE]);
    const reader = await connect();
    await reader.query("SET lock_timeout = '300ms'");
    const readDuringLate = async (): Promise<string> => {
      await waitUntil(
        'поздняя миграция спит',
        async () =>
          (
            await reader.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND query LIKE '%pg_sleep(0.8)%' AND pid <> pg_backend_pid()",
            )
          ).rows.length > 0,
      );
      return reader.query('SELECT count(*) FROM big').then(
        () => 'прочитано',
        (error: Error) => error.message,
      );
    };
    // По умолчанию одной транзакцией: ACCESS EXCLUSIVE ранней держится, пока спит поздняя.
    const [together, readTogether] = await Promise.all([
      runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log }).catch(
        (error: Error) => error,
      ),
      readDuringLate(),
    ]);
    expect(together).toBeInstanceOf(Error);
    expect(readTogether).toContain('lock timeout');
    expect(await journal(client)).toEqual([String(BASE)]);
    const [apart, readApart] = await Promise.all([
      runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: state.folder,
        log,
        transactionPerMigration: true,
      }).catch((error: Error) => error),
      readDuringLate(),
    ]);
    expect(apart).toBeInstanceOf(Error);
    expect(readApart).toBe('прочитано');
    expect(await journal(client)).toEqual([String(BASE), String(BASE + 1000)]);
  });

  it('метки не по порядку при нарезке на шаги — отказ до любых изменений', async () => {
    state.folder = writeMigrations([
      TABLE,
      CIC,
      // Новее помеченной по порядку журнала, но с меткой старше: шаг drizzle её пропустил бы.
      { tag: '0002_col', when: BASE + 500, statements: ['ALTER TABLE big ADD COLUMN note text'] },
    ]);
    const client = await connect();
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log }),
    ).rejects.toThrow('метки миграций не по порядку: 0002_col');
    expect(await exists(client, 'big')).toBe(false);
  });

  it('beforeMigrate записал журнал так, что миграция стала пропущенной, — отказ проверкой ПОСЛЕ хука', async () => {
    const first = { tag: '0000_a', when: BASE, statements: ['CREATE TABLE a (x integer)'] };
    const second = { tag: '0001_b', when: BASE + 1000, statements: ['CREATE TABLE b (x integer)'] };
    state.folder = writeMigrations([first, second]);
    const files = readMigrationFiles({ migrationsFolder: state.folder });
    const client = await connect();
    const failure = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      // Пометка базовой миграции, ошибочно отметившая вторую применённой, а первую — нет.
      beforeMigrate: async (session) => {
        await session.query('CREATE SCHEMA IF NOT EXISTS drizzle');
        await session.query(
          'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
        );
        await session.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [
          files[1]?.hash,
          BASE + 1000,
        ]);
      },
    }).catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain('миграции 0000_a');
    expect(await exists(client, 'a')).toBe(false);
  });

  it('порционная миграция: бэкфилл порциями до нуля строк, отчёт со строками и порциями; прерванная продолжается с места', async () => {
    state.folder = writeMigrations([
      {
        tag: '0000_rows',
        when: BASE,
        statements: [
          'CREATE TABLE rows (id integer PRIMARY KEY, note text)',
          'INSERT INTO rows SELECT g FROM generate_series(1, 2500) g',
        ],
      },
    ]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    const BACKFILL = {
      tag: '0001_backfill',
      when: BASE + 1000,
      statements: [
        "-- pg-migrate:batched batch=1000 pause=150\nUPDATE rows SET note = 'x' WHERE id IN (SELECT id FROM rows WHERE note IS NULL ORDER BY id LIMIT $1)",
      ],
    };
    state.folder = writeMigrations([
      {
        tag: '0000_rows',
        when: BASE,
        statements: [
          'CREATE TABLE rows (id integer PRIMARY KEY, note text)',
          'INSERT INTO rows SELECT g FROM generate_series(1, 2500) g',
        ],
      },
      BACKFILL,
    ]);
    // Отмена посреди: сделанные порции остаются, записи в журнале нет.
    const controller = new AbortController();
    const filled = async (): Promise<number> =>
      (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM rows WHERE note = 'x'")).rows[0]
        ?.n ?? -1;
    const watcher = await connect();
    void waitUntil('первая порция', async () => {
      const { rows } = await watcher.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM rows WHERE note = 'x'",
      );
      return (rows[0]?.n ?? 0) >= 1000;
    }).then(() => controller.abort(new Error('остановка пода')));
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log, signal: controller.signal }),
    ).rejects.toThrow('остановка пода');
    const partial = await filled();
    expect(partial).toBeGreaterThanOrEqual(1000);
    expect(partial).toBeLessThan(2500);
    expect(await journal(client)).toEqual([String(BASE)]);
    const report = await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(await filled()).toBe(2500);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ tags: ['0001_backfill'], kind: 'batched', rows: 2500 - partial });
    // Порций — по тысяче и одна пустая, по которой видно, что строк не осталось.
    expect(report.steps[0]?.batches).toBe(Math.ceil((2500 - partial) / 1000) + 1);
    expect(await journal(client)).toEqual([String(BASE), String(BASE + 1000)]);
  });

  it('незнакомая директива — отказ с файлом до любых изменений', async () => {
    state.folder = writeMigrations([
      TABLE,
      {
        tag: '0001_typo',
        when: BASE + 1000,
        statements: ['-- pg-migrate:bached\nUPDATE big SET name = name'],
      },
    ]);
    const client = await connect();
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log }),
    ).rejects.toThrow('миграция 0001_typo: «-- pg-migrate:bached» — незнакомая директива');
    expect(await exists(client, 'big')).toBe(false);
  });

  it('фазы: expand откладывает contract и всё после, contract с неприменёнными до него — отказ', async () => {
    const EXPAND = { tag: '0001_add', when: BASE + 1000, statements: ['ALTER TABLE big ADD COLUMN v2 text'] };
    const CONTRACT = {
      tag: '0002_drop',
      when: BASE + 2000,
      statements: ['-- pg-migrate:phase=contract\nALTER TABLE big DROP COLUMN name'],
    };
    const AFTER = { tag: '0003_more', when: BASE + 3000, statements: ['ALTER TABLE big ADD COLUMN v3 text'] };
    state.folder = writeMigrations([TABLE, EXPAND, CONTRACT, AFTER]);
    const client = await connect();
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log, phase: 'contract' }),
    ).rejects.toThrow('фаза contract: перед contract-миграцией 0002_drop не применены 0000_t, 0001_add');
    expect(await exists(client, 'big')).toBe(false);
    const expand = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      phase: 'expand',
    });
    expect(expand.deferred).toEqual(['0002_drop', '0003_more']);
    expect(await journal(client)).toEqual([String(BASE), String(BASE + 1000)]);
    const contract = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      phase: 'contract',
    });
    expect(contract.steps.flatMap((step) => step.tags)).toEqual(['0002_drop', '0003_more']);
    expect(contract.deferred).toEqual([]);
  });

  it('отчёт: шаги с длительностью, медленная миграция — предупреждение', async () => {
    state.folder = writeMigrations([
      TABLE,
      CIC,
      { tag: '0002_slow', when: BASE + 2000, statements: ['SELECT pg_sleep(0.05)'] },
    ]);
    const client = await connect();
    const report = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      slowMigrationMs: 40,
    });
    expect(report.steps.map((step) => [step.tags, step.kind])).toEqual([
      [['0000_t'], 'transaction'],
      [['0001_idx'], 'no-transaction'],
      [['0002_slow'], 'transaction'],
    ]);
    expect(report.steps.every((step) => step.durationMs >= 0)).toBe(true);
    expect(report.durationMs).toBeGreaterThanOrEqual(
      report.steps.reduce((sum, step) => sum + step.durationMs, 0),
    );
    expect(state.lines.filter((line) => line.startsWith('медленная миграция: 0002_slow'))).toHaveLength(1);
    expect(state.lines.some((line) => line.startsWith('применено: 0001_idx (no-transaction) за'))).toBe(true);
  });

  it('отредактированная применённая и пропущенная вместе: отказ называет только пропущенную, строка — только отредактированную', async () => {
    const first = { tag: '0000_a', when: BASE, statements: ['CREATE TABLE a (x integer)'] };
    const third = { tag: '0002_c', when: BASE + 2000, statements: ['CREATE TABLE c (x integer)'] };
    state.folder = writeMigrations([first, third]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    // Ничего не правили — ни строки об отредактированных.
    expect(state.lines.some((line) => line.includes('отредактированы'))).toBe(false);
    state.folder = writeMigrations([
      { ...first, statements: ['CREATE TABLE a (x integer, y integer)'] },
      { tag: '0001_b', when: BASE + 1000, statements: ['CREATE TABLE b (x integer)'] },
      third,
    ]);
    const failure = await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log }).catch(
      (error: unknown) => error as Error,
    );
    expect((failure as Error).message).toMatch(/^миграции 0001_b \(when \d+\) старше последней/);
    expect((failure as Error).message).not.toContain('0000_a');
    const edited = state.lines.filter((line) => line.includes('отредактированы'));
    expect(edited).toHaveLength(1);
    expect(edited[0]).toContain('0000_a');
    expect(edited[0]).not.toContain('0001_b');
  });
});
