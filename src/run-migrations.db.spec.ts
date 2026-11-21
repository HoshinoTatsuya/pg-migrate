import { createServer, type Server, type Socket } from 'node:net';

import { readMigrationFiles } from 'drizzle-orm/migrator';

import { Client } from 'pg';

import { connectWithRetry } from './connect-with-retry';
import { LOCK_KEY_HASH, LOCK_KEY_SQL } from './constants/lock-key-hash.constant';
import { NO_TRANSACTION_MARKER } from './constants/no-transaction-marker.constant';
import { POSTGRES_LIMIT } from './constants/postgres-limit.constant';
import { TIMER_LIMIT } from './constants/timer-limit.constant';
import { runMigrations } from './run-migrations';
import { createTestDatabase, removeFolder, writeMigrations } from './testing/test-database';

/**
 * На НАСТОЯЩЕМ Postgres: advisory-лок, lock_timeout и INVALID-индекс видны
 * только серверу. Адрес — PG_TEST_URL (`pnpm test` поднимает postgres:17 в
 * docker); без адреса набор пропускается, и jest-assert-no-skipped валит прогон.
 */
const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

const INIT = {
  tag: '0000_init',
  statements: [
    'CREATE TABLE items (id integer PRIMARY KEY, name text NOT NULL)',
    'CREATE INDEX items_name_idx ON items (name)',
  ],
};
const ADD_COLUMN = { tag: '0001_add_column', statements: ['ALTER TABLE items ADD COLUMN note text'] };

describeDb('runMigrations [нужен PG_TEST_URL]', () => {
  let db: { url: string; drop(): Promise<void> };
  let folder = '';
  const clients: Client[] = [];
  const connect = async (): Promise<Client> => {
    const client = new Client({ connectionString: db.url });
    await client.connect();
    clients.push(client);
    return client;
  };
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  beforeEach(async () => {
    db = await createTestDatabase(adminUrl as string);
    lines.length = 0;
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.end().catch(() => undefined);
    }
    await db.drop();
    removeFolder(folder);
  });

  const advisoryLocks = async (client: Client): Promise<number> =>
    Number(
      (
        await client.query(
          "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        )
      ).rows[0].n,
    );

  it('применяет миграции, повтор — без изменений; лок снят и lock_timeout сброшен', async () => {
    folder = writeMigrations([INIT, ADD_COLUMN]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'svc:schema-migrations', migrationsFolder: folder, log });
    await runMigrations(client, { lockKey: 'svc:schema-migrations', migrationsFolder: folder, log });

    const columns = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'items' ORDER BY 1",
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(['id', 'name', 'note']);
    const journal = await client.query('SELECT count(*) AS n FROM drizzle.__drizzle_migrations');
    expect(Number(journal.rows[0].n)).toBe(2);
    expect(await advisoryLocks(client)).toBe(0);
    expect((await client.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
  });

  it('два параллельных мигратора: оба успешны, каждая миграция применена ОДИН раз', async () => {
    folder = writeMigrations([INIT, ADD_COLUMN]);
    const [first, second] = [await connect(), await connect()];
    const options = { lockKey: 'svc:schema-migrations', migrationsFolder: folder, log };
    await expect(
      Promise.all([runMigrations(first, options), runMigrations(second, options)]),
    ).resolves.toBeDefined();
    const journal = await first.query('SELECT count(*) AS n FROM drizzle.__drizzle_migrations');
    expect(Number(journal.rows[0].n)).toBe(2);
  });

  // Без потолка мигратор ждал бы держателя бессрочно: тест упал бы по таймауту
  // jest, а не замером стенных часов (на занятой машине такой замер флакает).
  it('чужая транзакция держит таблицу — отказ по lock_timeout с подсказкой, а не вечное ожидание', async () => {
    folder = writeMigrations([INIT]);
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log });
    removeFolder(folder);
    folder = writeMigrations([INIT, ADD_COLUMN]);

    const holder = await connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE items IN ACCESS SHARE MODE');
    const failure = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: folder,
      log,
      lockTimeoutMs: 300,
    }).catch((error: unknown) => error as Error);
    await holder.query('ROLLBACK');

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('дольше 300 мс');
    // Отказ откатил миграцию целиком и не оставил ни лока, ни потолка в сессии.
    const columns = await client.query(
      "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'items'",
    );
    expect(Number(columns.rows[0].n)).toBe(2);
    expect(await advisoryLocks(client)).toBe(0);
    expect((await client.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
  });

  it('второй мигратор ЖДЁТ первого дольше lock_timeout и не отказывает', async () => {
    folder = writeMigrations([INIT]);
    const [first, second] = [await connect(), await connect()];
    await first.query("SELECT pg_advisory_lock(hashtext('k'))");
    const waiting = runMigrations(second, {
      lockKey: 'k',
      migrationsFolder: folder,
      log,
      lockTimeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await first.query("SELECT pg_advisory_unlock(hashtext('k'))");
    await expect(waiting).resolves.toHaveProperty('deferred', []);
  });

  it('INVALID-индекс — отказ ДО любых изменений; обрубок _ccnew — только строка в логе', async () => {
    const client = await connect();
    await client.query('CREATE TABLE dup (k integer)');
    await client.query('INSERT INTO dup VALUES (1), (1)');
    // Настоящий INVALID: CONCURRENTLY на дублях падает и оставляет индекс.
    await client.query('CREATE UNIQUE INDEX CONCURRENTLY dup_k_uidx ON dup (k)').catch(() => undefined);
    await client.query('CREATE UNIQUE INDEX CONCURRENTLY dup_k_uidx_ccnew ON dup (k)').catch(() => undefined);
    const invalid = await client.query('SELECT count(*) AS n FROM pg_index WHERE NOT indisvalid');
    expect(Number(invalid.rows[0].n)).toBe(2);

    folder = writeMigrations([INIT]);
    await expect(runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log })).rejects.toThrow(
      // Рецепт целиком: пересборка и как найти дубли, которые её не пускают.
      /REINDEX INDEX CONCURRENTLY "public"\."dup_k_uidx"[\s\S]*сначала найти их с SET enable_indexscan = off/,
    );
    const applied = await client.query("SELECT to_regclass('items') AS t");
    expect(applied.rows[0].t).toBeNull();
    expect(lines.some((line) => line.includes('dup_k_uidx_ccnew') && line.includes('DROP INDEX'))).toBe(true);

    await client.query('DROP INDEX dup_k_uidx');
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log }),
    ).resolves.toHaveProperty('deferred', []);
  });

  it('обрубок _ccnew — строка один раз за прогон, если после применения ничего не изменилось', async () => {
    const client = await connect();
    await client.query('CREATE TABLE dup (k integer)');
    await client.query('INSERT INTO dup VALUES (1), (1)');
    await client.query('CREATE UNIQUE INDEX CONCURRENTLY dup_k_uidx_ccnew ON dup (k)').catch(() => undefined);
    const leftoverLines = (): string[] => lines.filter((line) => line.includes('dup_k_uidx_ccnew'));

    folder = writeMigrations([INIT]);
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log }),
    ).resolves.toHaveProperty('deferred', []);
    expect(leftoverLines()).toHaveLength(1);

    // Применять нечего: проверки до и после видят тот же обрубок — строка та же, одна.
    lines.length = 0;
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log }),
    ).resolves.toHaveProperty('deferred', []);
    expect(leftoverLines()).toHaveLength(1);
    expect(lines).toContain('миграции применены');
  });

  it('ошибка миграции несёт причину базы, а не только текст оператора', async () => {
    folder = writeMigrations([
      {
        tag: '0000_bad',
        statements: ['CREATE TABLE t (id integer PRIMARY KEY)', 'INSERT INTO t VALUES (1), (1)'],
      },
    ]);
    const client = await connect();
    const failure = await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log }).catch(
      (e: unknown) => e as Error,
    );
    expect((failure as Error).message).toMatch(/Миграции не применены: duplicate key/);
    expect((failure as Error).message).toContain('подробности: Key (id)=(1) already exists');
  });

  /**
   * Держатель лока завис (сессия упавшего хоста): раньше второй запуск ждал
   * бессрочно и молча. Теперь — строка с держателем в журнале и отказ по
   * потолку с ним же.
   */
  it('лок миграций занят дольше потолка — отказ с держателем, пока ждём — строка с ним', async () => {
    folder = writeMigrations([INIT]);
    const holder = await connect();
    await holder.query('SELECT pg_advisory_lock(hashtext($1))', ['k']);
    const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const client = await connect();

    const failure = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: folder,
      log,
      lockWaitMs: 600,
      lockPollMs: 100,
    }).catch((e: unknown) => e as Error);

    expect((failure as Error).message).toContain('занят дольше 600 мс');
    expect((failure as Error).message).toContain(`pid ${holderPid}`);
    expect(
      lines.some((line) => line.startsWith('жду лок миграций «k»') && line.includes(`pid ${holderPid}`)),
    ).toBe(true);
    // Таблицы не созданы: мигратор не начинал работу без лока.
    expect((await client.query("SELECT to_regclass('items') AS t")).rows[0].t).toBeNull();
  });

  /**
   * Обрыв соединения посреди миграции: уборка сессии в finally (RESET, unlock)
   * тоже падает, и раньше наружу уходила её ошибка «not queryable» вместо
   * причины отказа миграции (внешний аудит 13.11.2026).
   */
  it('обрыв соединения посреди миграции — наружу причина миграции, а не отказ уборки', async () => {
    folder = writeMigrations([{ tag: '0000_slow', statements: ['SELECT pg_sleep(5)'] }]);
    const client = await connect();
    client.on('error', () => undefined);
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const admin = await connect();
    const killer = setTimeout(() => {
      void admin.query('SELECT pg_terminate_backend($1)', [pid]).catch(() => undefined);
    }, 800);

    const failure = await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log })
      .catch((e: unknown) => e as Error)
      .finally(() => clearTimeout(killer));

    expect((failure as Error).message).toMatch(/^Миграции не применены: /);
    expect((failure as Error).message).not.toContain('not queryable');
  });

  it('отмена во время ожидания лока — отказ с причиной отмены сразу, без миграций', async () => {
    folder = writeMigrations([INIT]);
    const holder = await connect();
    await holder.query("SELECT pg_advisory_lock(hashtext('k'))");
    const client = await connect();
    const controller = new AbortController();
    const reason = new Error('SIGTERM пода');
    setTimeout(() => controller.abort(reason), 300);

    const failure = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: folder,
      log,
      lockPollMs: 60_000,
      signal: controller.signal,
    }).catch((e: unknown) => e);

    // lockPollMs = минута: без прерываемой паузы отказ пришёл бы только по таймауту jest.
    expect(failure).toBe(reason);
    expect((await client.query("SELECT to_regclass('items') AS t")).rows[0].t).toBeNull();
    expect(await advisoryLocks(client)).toBe(1); // только лок держателя
  });

  it('уже отменённый сигнал — отказ до лока и до любых изменений', async () => {
    folder = writeMigrations([INIT]);
    const client = await connect();
    const controller = new AbortController();
    controller.abort(new Error('отменено'));
    const beforeMigrate = jest.fn(async () => undefined);
    await expect(
      runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: folder,
        log,
        signal: controller.signal,
        beforeMigrate,
      }),
    ).rejects.toThrow('отменено');
    // Отказ ДО лока: ни проверок, ни хуков под ним.
    expect(beforeMigrate).not.toHaveBeenCalled();
    expect(await advisoryLocks(client)).toBe(0);
    expect((await client.query("SELECT to_regclass('items') AS t")).rows[0].t).toBeNull();
  });

  it('отмена в beforeMigrate — миграции не начинаются, лок снят', async () => {
    folder = writeMigrations([INIT]);
    const client = await connect();
    const controller = new AbortController();
    await expect(
      runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: folder,
        log,
        signal: controller.signal,
        beforeMigrate: async () => {
          controller.abort(new Error('дедлайн джобы'));
        },
      }),
    ).rejects.toThrow('дедлайн джобы');
    expect((await client.query("SELECT to_regclass('items') AS t")).rows[0].t).toBeNull();
    expect(await advisoryLocks(client)).toBe(0);
  });

  it('64-битный ключ: держатель того же ключа виден и не пускает, лок снят после', async () => {
    folder = writeMigrations([INIT]);
    const holder = await connect();
    await holder.query(`SELECT pg_advisory_lock(${LOCK_KEY_SQL.int8})`, ['k']);
    const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const client = await connect();
    const options = {
      lockKey: 'k',
      migrationsFolder: folder,
      log,
      lockKeyHash: LOCK_KEY_HASH.int8,
      lockWaitMs: 400,
      lockPollMs: 100,
    };

    const failure = await runMigrations(client, options).catch((e: unknown) => e as Error);
    expect((failure as Error).message).toContain(`pid ${holderPid}`);

    await holder.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL.int8})`, ['k']);
    await expect(runMigrations(client, options)).resolves.toHaveProperty('deferred', []);
    expect(await advisoryLocks(client)).toBe(0);
  });

  it('64-битный ключ не совпадает с 32-битным того же текста: это другой лок', async () => {
    const client = await connect();
    const keys = await client.query<{ a: string; b: string }>(
      `SELECT (${LOCK_KEY_SQL.hashtext})::text AS a, (${LOCK_KEY_SQL.int8})::text AS b`,
      ['k'],
    );
    expect(keys.rows[0]?.a).not.toBe(keys.rows[0]?.b);
    // Выход за 32 бита — иначе «64-битный» ключ ничего не добавлял бы.
    const wide = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM generate_series(1, 50) g WHERE abs((${LOCK_KEY_SQL.int8.replaceAll('$1', "('k' || g)")})) > 2147483647`,
    );
    expect(Number(wide.rows[0]?.n)).toBeGreaterThan(40);
  });

  it('журнал миграций — в заданных схеме и таблице', async () => {
    folder = writeMigrations([INIT, ADD_COLUMN]);
    const client = await connect();
    await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: folder,
      log,
      migrationsSchema: 'svc_meta',
      migrationsTable: 'applied',
    });
    expect(Number((await client.query('SELECT count(*) AS n FROM svc_meta.applied')).rows[0].n)).toBe(2);
    expect(
      (await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS t")).rows[0].t,
    ).toBeNull();
  });

  describe('0.4.0: миграция вне транзакции, лок не этой сессии, повтор 55P03, свои схемы', () => {
    const BASE = 1_700_000_000_000;
    const TABLE = { tag: '0000_t', when: BASE, statements: ['CREATE TABLE big (id integer, name text)'] };
    const CONCURRENT = {
      tag: '0001_idx',
      when: BASE + 1000,
      statements: [
        `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS big_name_idx ON big (name)`,
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS big_id_idx ON big (id)',
      ],
    };
    const COLUMN = {
      tag: '0002_col',
      when: BASE + 2000,
      statements: ['ALTER TABLE big ADD COLUMN note text'],
    };
    const journalRows = async (client: Client) =>
      (
        await client.query<{ hash: string; created_at: string }>(
          'SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at',
        )
      ).rows;

    it('помеченная миграция идёт вне транзакции: CONCURRENTLY проходит, журнал — те же хэши, что у drizzle', async () => {
      folder = writeMigrations([TABLE, CONCURRENT, COLUMN]);
      const client = await connect();
      await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log });

      const indexes = await client.query<{ name: string; valid: boolean }>(
        "SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname LIKE 'big_%' ORDER BY 1",
      );
      expect(indexes.rows).toEqual([
        { name: 'big_id_idx', valid: true },
        { name: 'big_name_idx', valid: true },
      ]);
      const columns = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'big' ORDER BY 1",
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(['id', 'name', 'note']);
      const expected = readMigrationFiles({ migrationsFolder: folder }).map((m) => ({
        hash: m.hash,
        created_at: String(m.folderMillis),
      }));
      expect(await journalRows(client)).toEqual(expected);
      // Повтор — ничего не применяет и не падает.
      await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log });
      expect(await journalRows(client)).toHaveLength(3);
      expect(await advisoryLocks(client)).toBe(0);
    });

    it('контроль: без пометки та же миграция падает — CONCURRENTLY в транзакции запрещён', async () => {
      const unmarked = {
        ...CONCURRENT,
        statements: ['CREATE INDEX CONCURRENTLY big_name_idx ON big (name)'],
      };
      folder = writeMigrations([TABLE, unmarked]);
      const client = await connect();
      await expect(runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log })).rejects.toThrow(
        /transaction block/,
      );
    });

    it('отказ внутри помеченной: журнал без неё, следующие не применены, лок снят', async () => {
      const broken = {
        ...CONCURRENT,
        statements: [`${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY nope ON missing (x)`],
      };
      folder = writeMigrations([TABLE, broken, COLUMN]);
      const client = await connect();
      await expect(runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log })).rejects.toThrow(
        'Миграции не применены',
      );
      expect(await journalRows(client)).toHaveLength(1);
      const note = await client.query(
        "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'big' AND column_name = 'note'",
      );
      expect(Number(note.rows[0].n)).toBe(0);
      expect(await advisoryLocks(client)).toBe(0);
    });

    it('лок взят не этой сессией (пулер в transaction mode) — отказ до миграций', async () => {
      folder = writeMigrations([TABLE]);
      const client = await connect();
      const other = await connect();
      // Как пулер: запрос проверки уходит в ДРУГОЕ соединение сервера.
      const pooled = new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return (text: unknown, values?: unknown[]) =>
              typeof text === 'string' && text.includes('pg_backend_pid()')
                ? other.query(text, values)
                : target.query(text as string, values);
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(runMigrations(pooled, { lockKey: 'k', migrationsFolder: folder, log })).rejects.toThrow(
        'не этой сессией',
      );
      expect((await client.query("SELECT to_regclass('big') AS t")).rows[0].t).toBeNull();
      expect(await advisoryLocks(client)).toBe(0);
    });

    it('lockTimeoutRetry: чужая транзакция отпустила таблицу — повтор применяет; без опции — отказ', async () => {
      folder = writeMigrations([TABLE]);
      const client = await connect();
      await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log });
      removeFolder(folder);
      folder = writeMigrations([TABLE, COLUMN]);
      const holder = await connect();
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE big IN ACCESS SHARE MODE');
      const released = new Promise((resolve) => setTimeout(resolve, 500)).then(() =>
        holder.query('ROLLBACK'),
      );
      await runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: folder,
        log,
        lockTimeoutMs: 100,
        lockTimeoutRetry: { attempts: 20, backoffMs: 100 },
      });
      await released;
      expect(lines.some((line) => line.includes('попытка 1 из 20'))).toBe(true);
      const note = await client.query(
        "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'big' AND column_name = 'note'",
      );
      expect(Number(note.rows[0].n)).toBe(1);
    });

    it('lockTimeoutRetry с неверными числами — отказ до лока', async () => {
      folder = writeMigrations([TABLE]);
      const client = await connect();
      await expect(
        runMigrations(client, {
          lockKey: 'k',
          migrationsFolder: folder,
          log,
          lockTimeoutRetry: { attempts: 0, backoffMs: 1 },
        }),
      ).rejects.toThrow('lockTimeoutRetry');
    });

    it('invalidIndexSchemas: INVALID-индекс в третьей схеме — отказ до миграций', async () => {
      const client = await connect();
      await client.query('CREATE SCHEMA side');
      await client.query('CREATE TABLE side.dup (k integer)');
      await client.query('INSERT INTO side.dup VALUES (1), (1)');
      await client
        .query('CREATE UNIQUE INDEX CONCURRENTLY dup_side_uidx ON side.dup (k)')
        .catch(() => undefined);
      folder = writeMigrations([TABLE]);
      await expect(
        runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log }),
      ).resolves.toHaveProperty('deferred', []);
      removeFolder(folder);
      folder = writeMigrations([TABLE, COLUMN]);
      await expect(
        runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log, invalidIndexSchemas: ['side'] }),
      ).rejects.toThrow('dup_side_uidx');
    });
  });

  describe('миграция, которую drizzle пропустил бы молча', () => {
    const BASE = 1_700_000_000_000;
    const A = { tag: '0000_a', when: BASE, statements: ['CREATE TABLE a (id integer)'] };
    const B = { tag: '0001_b', when: BASE + 1000, statements: ['CREATE TABLE b (id integer)'] };
    const C = { tag: '0002_c', when: BASE + 2000, statements: ['CREATE TABLE c (id integer)'] };
    const tables = async (client: Client): Promise<string[]> =>
      (
        await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('a','b','c') ORDER BY 1",
        )
      ).rows.map((row) => row.tablename);

    it('метка старше применённой и её нет в журнале — отказ до изменений, лок снят', async () => {
      folder = writeMigrations([A, C]);
      const client = await connect();
      await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log });
      removeFolder(folder);
      // Ветку с B влили после C: метка B старше последней применённой (C).
      folder = writeMigrations([A, B, C]);
      await expect(runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log })).rejects.toThrow(
        /0001_b \(when 1700000001000\).*пропустил бы/,
      );
      expect(await tables(client)).toEqual(['a', 'c']);
      expect(await advisoryLocks(client)).toBe(0);
    });

    it('та же миграция с меткой новее применённой — применяется', async () => {
      folder = writeMigrations([A, C]);
      const client = await connect();
      await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log });
      removeFolder(folder);
      folder = writeMigrations([A, C, { ...B, when: BASE + 3000 }]);
      await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log });
      expect(await tables(client)).toEqual(['a', 'b', 'c']);
    });

    it('применённую миграцию отредактировали — строка в логе, не отказ', async () => {
      folder = writeMigrations([A, C]);
      const client = await connect();
      await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log });
      removeFolder(folder);
      folder = writeMigrations([{ ...A, statements: ['CREATE TABLE a (id integer) -- поправили текст'] }, C]);
      await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log });
      expect(lines.some((line) => line.includes('отредактированы') && line.includes('0000_a'))).toBe(true);
    });

    it('журнал в своей схеме и таблице — пропуск виден и там', async () => {
      const journal = { migrationsSchema: 'svc_meta', migrationsTable: 'applied' };
      folder = writeMigrations([A, C]);
      const client = await connect();
      await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log, ...journal });
      removeFolder(folder);
      folder = writeMigrations([A, B, C]);
      await expect(
        runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log, ...journal }),
      ).rejects.toThrow(/0001_b.*"svc_meta"\."applied"/);
    });

    it('первый запуск на пустой базе — без отказа, журнала ещё нет', async () => {
      folder = writeMigrations([A, B, C]);
      const client = await connect();
      await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log });
      expect(await tables(client)).toEqual(['a', 'b', 'c']);
    });
  });

  it('потолок оператора: долгая миграция — отказ, потолки сессии сброшены после', async () => {
    folder = writeMigrations([{ tag: '0000_slow', statements: ['SELECT pg_sleep(3)'] }]);
    const client = await connect();
    const failure = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: folder,
      log,
      statementTimeoutMs: 200,
      idleInTransactionTimeoutMs: 5_000,
    }).catch((e: unknown) => e as Error);
    expect((failure as Error).message).toMatch(
      /^Миграции не применены: canceling statement due to statement timeout/,
    );
    expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0');
    expect(
      (await client.query('SHOW idle_in_transaction_session_timeout')).rows[0]
        .idle_in_transaction_session_timeout,
    ).toBe('0');
    expect(await advisoryLocks(client)).toBe(0);
  });

  it('подсказка REINDEX — со схемой и экранированием имени', async () => {
    const client = await connect();
    await client.query('CREATE SCHEMA "my svc"');
    await client.query('CREATE TABLE "my svc".dup (k integer)');
    await client.query('INSERT INTO "my svc".dup VALUES (1), (1)');
    await client
      .query('CREATE UNIQUE INDEX CONCURRENTLY "dup ""q"" uidx" ON "my svc".dup (k)')
      .catch(() => undefined);
    folder = writeMigrations([INIT]);
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log, schema: 'my svc' }),
    ).rejects.toThrow('REINDEX INDEX CONCURRENTLY "my svc"."dup ""q"" uidx"');
  });

  const sessionState = async (client: Client): Promise<{ locks: number; lockTimeout: string }> => ({
    locks: await advisoryLocks(client),
    lockTimeout: (await client.query('SHOW lock_timeout')).rows[0].lock_timeout as string,
  });

  /**
   * Хук оставил сессию в прерванной транзакции (25P02): RESET и снятие лока в
   * ней отказывали, отказы глотались, и сессия, которую вызывающий использует
   * дальше, держала лок миграций (следующий деплой ждал его lockWaitMs) и
   * потолок lock_timeout (внешний аудит 14.11.2026).
   */
  it('afterMigrate упал в прерванной транзакции — наружу его отказ, лок снят, потолок сброшен', async () => {
    folder = writeMigrations([INIT]);
    const client = await connect();
    const hookFailure = new Error('хук упал');
    await expect(
      runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: folder,
        log,
        afterMigrate: async (c) => {
          await c.query('BEGIN');
          await c.query('SELECT 1/0').catch(() => undefined);
          throw hookFailure;
        },
      }),
    ).rejects.toBe(hookFailure);
    expect(await sessionState(client)).toEqual({ locks: 0, lockTimeout: '0' });
  });

  it('afterMigrate проглотил отказ в своей транзакции — отказ с причиной, лок снят', async () => {
    folder = writeMigrations([INIT]);
    const client = await connect();
    await expect(
      runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: folder,
        log,
        afterMigrate: async (c) => {
          await c.query('BEGIN');
          await c.query('SELECT 1/0').catch(() => undefined);
        },
      }),
    ).rejects.toThrow('afterMigrate оставил прерванную транзакцию');
    expect(await sessionState(client)).toEqual({ locks: 0, lockTimeout: '0' });
    // Сами миграции применены: отказ — про хук.
    expect((await client.query("SELECT to_regclass('items') AS t")).rows[0].t).toBe('items');
  });

  /**
   * Хук не завершил транзакцию: RESET шёл внутри неё и откатывался вместе с ней
   * (потолок оставался на сессии), а работа хука терялась при закрытии
   * соединения — при «миграции применены» в журнале деплоя.
   */
  it('afterMigrate не завершил транзакцию — отказ, транзакция откатана, потолок не остался', async () => {
    folder = writeMigrations([INIT]);
    const client = await connect();
    await expect(
      runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: folder,
        log,
        afterMigrate: async (c) => {
          await c.query('BEGIN');
          await c.query('CREATE TABLE hook_side (x integer)');
        },
      }),
    ).rejects.toThrow('afterMigrate оставил незавершённую транзакцию');
    // Транзакции нет: ROLLBACK вызывающего ничего не отменяет.
    await client.query('ROLLBACK');
    expect(await sessionState(client)).toEqual({ locks: 0, lockTimeout: '0' });
    expect((await client.query("SELECT to_regclass('hook_side') AS t")).rows[0].t).toBeNull();
  });

  it('RESET упал без исходной ошибки — наружу его отказ, но лок всё равно снят', async () => {
    folder = writeMigrations([INIT]);
    const client = await connect();
    const resetFailure = new Error('RESET не прошёл');
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    // biome-ignore lint/suspicious/noExplicitAny: подмена перегруженного метода драйвера
    (client as any).query = (...args: unknown[]): unknown =>
      typeof args[0] === 'string' && args[0].startsWith('RESET ')
        ? Promise.reject(resetFailure)
        : original(...args);
    await expect(runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log })).rejects.toBe(
      resetFailure,
    );
    expect(await advisoryLocks(client)).toBe(0);
  });

  /**
   * `schema` журнал не переносит и переносить не будет: у тех, кто её уже
   * задал, перенос сменил бы журнал, и drizzle применил бы все миграции заново.
   * Вместо этого — строка в журнал деплоя.
   */
  it('схема задана без migrationsSchema — журнал на прежнем месте, строка о нём в логе', async () => {
    folder = writeMigrations([INIT]);
    const client = await connect();
    await client.query('CREATE SCHEMA billing');
    await runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log, schema: 'billing' });
    const journal = await client.query(
      "SELECT table_schema FROM information_schema.tables WHERE table_name = '__drizzle_migrations'",
    );
    expect(journal.rows.map((row) => row.table_schema)).toEqual(['drizzle']);
    expect(lines.some((line) => line.startsWith('схема billing, а журнал миграций — drizzle.'))).toBe(true);

    lines.length = 0;
    await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: folder,
      log,
      schema: 'billing',
      migrationsSchema: 'drizzle',
    });
    expect(lines.some((line) => line.includes('журнал миграций'))).toBe(false);
  });

  it.each([
    [{ lockKey: 'k ' }, 'пробелами по краям'],
    [{ lockWaitMs: 0 }, 'lockWaitMs'],
    [{ statementTimeoutMs: 0 }, 'statement_timeout'],
    [{ idleInTransactionTimeoutMs: 1.5 }, 'idle_in_transaction_session_timeout'],
    [{ migrationsTable: ' ' }, 'migrationsTable'],
    [{ lockKeyHash: 'md5' as never }, 'lockKeyHash'],
    // setTimeout превращает их в 1 мс: ожидание лока — запросы к базе без паузы.
    [{ lockPollMs: 0 }, 'lockPollMs'],
    [{ lockPollMs: -100 }, 'lockPollMs'],
    [{ lockPollMs: Number.NaN }, 'lockPollMs'],
    [{ lockPollMs: TIMER_LIMIT.MAX_DELAY_MS + 1 }, 'lockPollMs'],
    // Выше int4 Postgres отвечает 22023 уже под локом — отказ обязан быть раньше.
    [{ lockTimeoutMs: POSTGRES_LIMIT.MAX_TIMEOUT_MS + 1 }, 'не больше'],
    [{ statementTimeoutMs: POSTGRES_LIMIT.MAX_TIMEOUT_MS + 1 }, 'не больше'],
    [{ idleInTransactionTimeoutMs: Number.MAX_SAFE_INTEGER }, 'не больше'],
  ])('%p — отказ до обращения к базе', async (extra, reason) => {
    folder = writeMigrations([INIT]);
    const client = await connect();
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log, ...extra }),
    ).rejects.toThrow(reason);
  });

  it('потолки сессии ровно на пределе int4 — принимаются, сброшены после', async () => {
    folder = writeMigrations([INIT]);
    const client = await connect();
    await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: folder,
      log,
      lockTimeoutMs: POSTGRES_LIMIT.MAX_TIMEOUT_MS,
      statementTimeoutMs: POSTGRES_LIMIT.MAX_TIMEOUT_MS,
    });
    expect((await client.query("SELECT to_regclass('items') AS t")).rows[0].t).toBe('items');
    expect(await sessionState(client)).toEqual({ locks: 0, lockTimeout: '0' });
  });

  /**
   * Задан только журнал в своей схеме — проверялась одна `public`, и
   * INVALID-индекс в схеме сервиса проходил мимо (внешний аудит 14.11.2026).
   */
  it('INVALID-индекс в схеме журнала (migrationsSchema) — отказ до миграций', async () => {
    const client = await connect();
    await client.query('CREATE SCHEMA billing');
    await client.query('CREATE TABLE billing.dup (k integer)');
    await client.query('INSERT INTO billing.dup VALUES (1), (1)');
    await client
      .query('CREATE UNIQUE INDEX CONCURRENTLY dup_k_uidx ON billing.dup (k)')
      .catch(() => undefined);
    folder = writeMigrations([INIT]);
    await expect(
      runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log, migrationsSchema: 'billing' }),
    ).rejects.toThrow('INVALID-индексы в схеме billing');
    expect((await client.query("SELECT to_regclass('items') AS t")).rows[0].t).toBeNull();
    expect(await advisoryLocks(client)).toBe(0);
  });

  it.each([0, -1, 1.5])(
    'lockTimeoutMs=%p — отказ: 0 в Postgres значит «ждать вечно»',
    async (lockTimeoutMs) => {
      folder = writeMigrations([INIT]);
      const client = await connect();
      await expect(
        runMigrations(client, { lockKey: 'k', migrationsFolder: folder, log, lockTimeoutMs }),
      ).rejects.toThrow('lockTimeoutMs');
    },
  );
});

describe('connectWithRetry', () => {
  it.each([
    [Number.NaN, 100, 'deadlineMs'],
    [Number.POSITIVE_INFINITY, 100, 'deadlineMs'],
    [0, 100, 'deadlineMs'],
    [TIMER_LIMIT.MAX_DELAY_MS + 1, 100, 'deadlineMs'],
    [600, Number.NaN, 'intervalMs'],
    [600, -1, 'intervalMs'],
  ])('дедлайн %p, интервал %p — отказ до первой попытки', async (deadlineMs, intervalMs, reason) => {
    // NaN делал сравнение с дедлайном ложным всегда: повторы шли бы вечно.
    const log = jest.fn();
    await expect(
      connectWithRetry({ host: '127.0.0.1', port: 1 }, deadlineMs, intervalMs, log),
    ).rejects.toThrow(reason);
    expect(log).not.toHaveBeenCalled();
  });

  it('недоступная база — отказ к дедлайну с числом попыток и причиной', async () => {
    const log = jest.fn();
    await expect(
      connectWithRetry({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 200 }, 600, 150, log),
    ).rejects.toThrow(/База недоступна за 600 мс \(\d+ попыток\)/);
    expect(log.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * Сервер принимает TCP и молчит (как хост за security group, роняющей
   * ответы): без потолка на попытку ОДНО соединение ждало бы до таймаута TCP
   * ОС — минуты поверх дедлайна.
   */
  describe('молчащий сервер', () => {
    let server: Server;
    let port = 0;
    const sockets: Socket[] = [];
    beforeAll(async () => {
      server = createServer((socket) => {
        sockets.push(socket);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;
    });
    afterAll(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    });

    const within = <T>(ms: number, work: Promise<T>): Promise<T> =>
      Promise.race([
        work,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`дольше ${ms} мс`)), ms).unref()),
      ]);

    it('попытка не дольше остатка до дедлайна', async () => {
      await expect(
        within(
          5_000,
          connectWithRetry({ host: '127.0.0.1', port }, 700, 100, () => undefined),
        ),
      ).rejects.toThrow(/База недоступна за 700 мс/);
    });

    it('свой потолок вызывающего меньше остатка — действует он', async () => {
      const log = jest.fn();
      await expect(
        within(
          5_000,
          connectWithRetry({ host: '127.0.0.1', port, connectionTimeoutMillis: 150 }, 1_200, 50, log),
        ),
      ).rejects.toThrow(/База недоступна/);
      // 150 мс на попытку при дедлайне 1.2 с — попыток несколько, а не одна до дедлайна.
      expect(log.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('отмена прерывает паузу между попытками', async () => {
      const controller = new AbortController();
      const reason = new Error('остановка');
      setTimeout(() => controller.abort(reason), 400);
      await expect(
        within(
          3_000,
          connectWithRetry(
            { host: '127.0.0.1', port: 1, connectionTimeoutMillis: 100 },
            60_000,
            30_000,
            () => undefined,
            {
              signal: controller.signal,
            },
          ),
        ),
      ).rejects.toBe(reason);
    });
  });
});
