import { Client } from 'pg';

import { migrate } from '../examples/quick-start';
import { migrateTenants } from '../examples/schema-per-tenant';
import { createTestDatabase, removeFolder, writeMigrations } from './testing/test-database';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

/** Примеры README исполняются на настоящем Postgres: «компилируется» ещё не значит «работает». */
describeDb('примеры README на настоящей базе [нужен PG_TEST_URL]', () => {
  let database: { url: string; drop(): Promise<void> };
  let folder: string;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl as string);
    folder = writeMigrations([
      { tag: '0000_items', statements: ['CREATE TABLE items (id serial PRIMARY KEY, status text)'] },
      {
        tag: '0001_items_status_idx',
        statements: [
          '-- pg-migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS items_status_idx ON items (status)',
        ],
      },
    ]);
  });
  afterAll(async () => {
    removeFolder(folder);
    await database?.drop();
  });

  const catalog = async (): Promise<{
    table: string | null;
    index: string | null;
    valid: boolean | null;
  }> => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const { rows } = await client.query<{
        table: string | null;
        index: string | null;
        valid: boolean | null;
      }>(
        `SELECT to_regclass('public.items')::text AS table, to_regclass('public.items_status_idx')::text AS index,
                (SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.items_status_idx')) AS valid`,
      );
      return rows[0] as { table: string | null; index: string | null; valid: boolean | null };
    } finally {
      await client.end();
    }
  };

  it('quick-start: обе миграции применены (вторая — вне транзакции), повторный запуск ничего не делает', async () => {
    const lines: string[] = [];
    const first = await migrate(database.url, folder, (line) => lines.push(line));
    expect(first.steps.map((step) => ({ tags: step.tags, kind: step.kind }))).toEqual([
      { tags: ['0000_items'], kind: 'transaction' },
      { tags: ['0001_items_status_idx'], kind: 'no-transaction' },
    ]);
    await expect(catalog()).resolves.toEqual({ table: 'items', index: 'items_status_idx', valid: true });
    const again = await migrate(database.url, folder, (line) => lines.push(line));
    expect(again.steps).toEqual([]);
  });

  it('schema-per-tenant: миграции применены в каждой схеме арендатора', async () => {
    const plainFolder = writeMigrations([
      { tag: '0000_notes', statements: ['CREATE TABLE notes (id serial PRIMARY KEY, body text)'] },
    ]);
    try {
      const client = new Client({ connectionString: database.url });
      await client.connect();
      try {
        await expect(migrateTenants(client, plainFolder, ['a', 'b'])).resolves.toEqual([
          'tenant_a: applied',
          'tenant_b: applied',
        ]);
        const { rows } = await client.query<{ name: string }>(
          `SELECT to_regclass(s || '.notes')::text AS name FROM unnest(ARRAY['tenant_a', 'tenant_b']) AS s ORDER BY s`,
        );
        expect(rows).toEqual([{ name: 'tenant_a.notes' }, { name: 'tenant_b.notes' }]);
      } finally {
        await client.end();
      }
    } finally {
      removeFolder(plainFolder);
    }
  });
});
