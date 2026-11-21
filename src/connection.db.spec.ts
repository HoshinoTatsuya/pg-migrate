import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import { Client } from 'pg';

import { connectWithRetry } from './connect-with-retry';
import { NO_TRANSACTION_MARKER } from './constants/no-transaction-marker.constant';
import { runMigrations } from './run-migrations';
import { migratorDatabase } from './testing/migrator-database';
import { writeMigrations } from './testing/test-database';
import { waitUntil } from './testing/wait-until';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

const BASE = 1_700_000_000_000;

describeDb('соединение мигратора [нужен PG_TEST_URL]', () => {
  const { state, log, connect } = migratorDatabase(adminUrl);

  it('сервер разорвал сессию мигратора, пока хук ждёт, — отказ с причиной разрыва, процесс жив', async () => {
    state.folder = writeMigrations([
      { tag: '0000_t', when: BASE, statements: ['CREATE TABLE t (x integer)'] },
    ]);
    // Клиент БЕЗ своего обработчика 'error': так его передаёт точка входа деплоя.
    const client = new Client({ connectionString: state.url });
    await client.connect();
    const admin = await connect();
    try {
      const failure = await runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: state.folder,
        log,
        beforeMigrate: async (session) => {
          const { rows } = await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          await admin.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);
          // Разрыв приходит, пока активного запроса нет.
          await new Promise((resolve) => setTimeout(resolve, 300));
        },
      }).catch((error: unknown) => error as Error);
      expect((failure as Error).message).toContain(
        'соединение мигратора разорвано сервером: terminating connection due to administrator command',
      );
      expect(state.lines).toContain(
        'соединение мигратора разорвано: terminating connection due to administrator command',
      );
      expect(client.listenerCount('error')).toBe(0);
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  it('connectWithRetry: у клиента есть обработчик error — разрыв сессии строкой в лог, не падением процесса', async () => {
    const lines: string[] = [];
    const client = await connectWithRetry({ connectionString: state.url }, 5_000, 100, (line) =>
      lines.push(line),
    );
    const admin = await connect();
    try {
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await admin.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);
      await waitUntil('строка о разрыве', async () => lines.some((line) => line.includes('разорвано')));
      expect(lines.filter((line) => line.startsWith('соединение с базой разорвано: '))).not.toHaveLength(0);
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  it('под ролью без суперправ (владелец базы): журнал, CIC вне транзакции, лок и уборка', async () => {
    const role = `mig_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = await connect(adminUrl);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'mig' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    const database = new URL(state.url).pathname.slice(1);
    await admin.query(`ALTER DATABASE ${database} OWNER TO ${role}`);
    const url = new URL(state.url);
    url.username = role;
    url.password = 'mig';
    // Схема public на 15+ не даёт CREATE всем — владелец базы получает её явно, как в установке.
    const owner = await connect();
    await owner.query(`ALTER SCHEMA public OWNER TO ${role}`);
    state.folder = writeMigrations([
      { tag: '0000_t', when: BASE, statements: ['CREATE TABLE big (id integer, name text)'] },
      {
        tag: '0001_idx',
        when: BASE + 1000,
        statements: [
          `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS big_name_idx ON big (name)`,
        ],
      },
      { tag: '0002_col', when: BASE + 2000, statements: ['ALTER TABLE big ADD COLUMN note text'] },
    ]);
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const { rows } = await client.query<{ superuser: boolean }>(
        'SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
      );
      expect(rows).toEqual([{ superuser: false }]);
      const report = await runMigrations(client, {
        lockKey: 'k',
        migrationsFolder: state.folder,
        log,
        transactionPerMigration: true,
      });
      expect(report.steps.map((step) => step.kind)).toEqual(['transaction', 'no-transaction', 'transaction']);
      const journal = await client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
      expect(journal.rows[0].n).toBe(3);
      const locks = await client.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
      );
      expect(locks.rows[0].n).toBe(0);
    } finally {
      await client.end().catch(() => undefined);
      await owner.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER`);
      await owner.query(`DROP OWNED BY ${role}`);
      await admin.query(`ALTER DATABASE ${database} OWNER TO CURRENT_USER`);
      await admin.query(`DROP ROLE ${role}`);
    }
  });
});

describe('connectWithRetry: нижний порог попытки', () => {
  let server: Server;
  let port = 0;
  const sockets: Socket[] = [];
  beforeAll(async () => {
    // Принимает и сразу закрывает: быстрый отказ со своей причиной.
    server = createServer((socket) => {
      sockets.push(socket);
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('остаток после паузы меньше порога — новой попытки нет, причина — настоящая, а не таймаут огрызка', async () => {
    const lines: string[] = [];
    const failure = await connectWithRetry({ host: '127.0.0.1', port }, 1_500, 1_000, (line) =>
      lines.push(line),
    ).catch((error: unknown) => error as Error);
    // Прежде: попытка 2 с потолком ~500 мс, а при остатке в 1 мс — таймаут вместо причины.
    expect((failure as Error).message).toMatch(
      /^База недоступна за 1500 мс \(1 попыток\), последняя причина: /,
    );
    expect((failure as Error).message).not.toContain('timeout');
    expect(lines).toEqual([]);
  });
});
