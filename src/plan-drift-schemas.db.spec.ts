import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NO_TRANSACTION_MARKER } from './constants/no-transaction-marker.constant';
import { detectSchemaDrift } from './detect-schema-drift';
import { formatMigrationPlan } from './format-migration-plan';
import { MultiSchemaMigrationError } from './multi-schema-migration.error';
import { planMigrations } from './plan-migrations';
import { runMigrations } from './run-migrations';
import { runMigrationsForSchemas } from './run-migrations-for-schemas';
import { migratorDatabase } from './testing/migrator-database';
import { writeMigrations } from './testing/test-database';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

const BASE = 1_700_000_000_000;
const TABLE = {
  tag: '0000_items',
  when: BASE,
  statements: [
    "CREATE TABLE items (id serial PRIMARY KEY, name varchar(128) NOT NULL, status text DEFAULT 'new' NOT NULL, added_at timestamp (0) with time zone DEFAULT now() NOT NULL, note text)",
    'CREATE INDEX items_name_idx ON items (name)',
  ],
};
const CIC = {
  tag: '0001_idx',
  when: BASE + 1000,
  statements: [
    `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS items_status_idx ON items (status)`,
  ],
};
const COLUMN = {
  tag: '0002_col',
  when: BASE + 2000,
  statements: ['ALTER TABLE items ADD COLUMN extra integer'],
};

/** Снимок drizzle-kit (version 7) последней миграции — как его пишет drizzle-kit. */
const SNAPSHOT = {
  id: 'x',
  prevId: 'y',
  version: '7',
  dialect: 'postgresql',
  tables: {
    'public.items': {
      name: 'items',
      schema: '',
      columns: {
        id: { name: 'id', type: 'serial', primaryKey: true, notNull: true },
        name: { name: 'name', type: 'varchar(128)', primaryKey: false, notNull: true },
        status: { name: 'status', type: 'text', primaryKey: false, notNull: true, default: "'new'" },
        added_at: {
          name: 'added_at',
          type: 'timestamp (0) with time zone',
          primaryKey: false,
          notNull: true,
          default: 'now()',
        },
        note: { name: 'note', type: 'text', primaryKey: false, notNull: false },
        extra: { name: 'extra', type: 'integer', primaryKey: false, notNull: false },
      },
      indexes: {
        items_name_idx: {
          name: 'items_name_idx',
          columns: [],
          isUnique: false,
          concurrently: false,
          method: 'btree',
          with: {},
        },
        items_status_idx: {
          name: 'items_status_idx',
          columns: [],
          isUnique: false,
          concurrently: true,
          method: 'btree',
          with: {},
        },
      },
      foreignKeys: {},
      compositePrimaryKeys: {},
      uniqueConstraints: {},
      policies: {},
      checkConstraints: {},
      isRLSEnabled: false,
    },
  },
  enums: {},
  schemas: {},
  sequences: {},
  roles: {},
  policies: {},
  views: {},
  _meta: { columns: {}, schemas: {}, tables: {} },
};

describeDb('план, сверка схемы, многосхемный запуск [нужен PG_TEST_URL]', () => {
  const { state, log, connect } = migratorDatabase(adminUrl);

  it('план: шаги, вид, блокировки операторов — и ничего не применено', async () => {
    state.folder = writeMigrations([TABLE, CIC, COLUMN]);
    const client = await connect();
    const plan = await planMigrations(client, { migrationsFolder: state.folder });
    expect(plan.steps.map((step) => [step.kind, step.migrations.map((migration) => migration.tag)])).toEqual([
      ['transaction', ['0000_items']],
      ['no-transaction', ['0001_idx']],
      ['transaction', ['0002_col']],
    ]);
    expect(
      plan.steps.flatMap((step) => step.migrations.flatMap((m) => m.statements.map((s) => s.lock.mode))),
    ).toEqual(['—', 'SHARE', 'SHARE UPDATE EXCLUSIVE', 'ACCESS EXCLUSIVE']);
    const lines = formatMigrationPlan(plan);
    expect(lines[0]).toBe('шаг 1 (transaction): 0000_items');
    expect(
      lines.some(
        (line) => line.includes('CREATE INDEX items_name_idx') && line.includes('останавливает запись'),
      ),
    ).toBe(true);
    expect((await client.query("SELECT to_regclass('items') AS t")).rows[0].t).toBeNull();
    expect(
      (await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS t")).rows[0].t,
    ).toBeNull();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(formatMigrationPlan(await planMigrations(client, { migrationsFolder: state.folder }))).toEqual([
      'применять нечего',
    ]);
  });

  it('сверка со снимком: после миграций расхождений нет; ручные правки — каждая названа', async () => {
    state.folder = writeMigrations([TABLE, CIC, COLUMN]);
    writeFileSync(join(state.folder, 'meta', '0002_snapshot.json'), JSON.stringify(SNAPSHOT));
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(await detectSchemaDrift(client, { migrationsFolder: state.folder })).toEqual([]);
    // Ручные правки на проде мимо миграций.
    await client.query('ALTER TABLE items ADD COLUMN hotfix text');
    await client.query('ALTER TABLE items ALTER COLUMN name DROP NOT NULL');
    await client.query('ALTER TABLE items ALTER COLUMN status DROP DEFAULT');
    await client.query('ALTER TABLE items ALTER COLUMN extra TYPE bigint');
    await client.query('DROP INDEX items_status_idx');
    await client.query('CREATE INDEX items_note_idx ON items (note)');
    await client.query('CREATE TABLE manual (x integer)');
    const drift = await detectSchemaDrift(client, { migrationsFolder: state.folder });
    expect(new Set(drift.map((item) => JSON.stringify(item)))).toEqual(
      new Set(
        [
          { kind: 'column-nullability', object: 'public.items.name', expected: 'NOT NULL', actual: 'NULL' },
          {
            kind: 'column-default',
            object: 'public.items.status',
            expected: 'DEFAULT',
            actual: 'без DEFAULT',
          },
          { kind: 'column-type', object: 'public.items.extra', expected: 'integer', actual: 'bigint' },
          { kind: 'extra-column', object: 'public.items.hotfix' },
          { kind: 'missing-index', object: 'public.items_status_idx' },
          { kind: 'extra-index', object: 'public.items_note_idx' },
          { kind: 'extra-table', object: 'public.manual' },
        ].map((item) => JSON.stringify(item)),
      ),
    );
    expect(drift).toHaveLength(7);
    expect(
      await detectSchemaDrift(client, { migrationsFolder: state.folder, ignoreTables: ['public.manual'] }),
    ).toHaveLength(6);
  });

  it('многосхемный: одни миграции в каждой схеме со своим журналом; отказ — отчёт по каждой', async () => {
    state.folder = writeMigrations([
      { tag: '0000_t', when: BASE, statements: ['CREATE TABLE notes (id integer)'] },
      {
        tag: '0001_idx',
        when: BASE + 1000,
        statements: [
          `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS notes_id_idx ON notes (id)`,
        ],
      },
    ]);
    const client = await connect();
    const reports = await runMigrationsForSchemas(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      schemas: ['tenant_a', 'tenant_b'],
    });
    expect(reports.map((report) => [report.schema, report.status])).toEqual([
      ['tenant_a', 'applied'],
      ['tenant_b', 'applied'],
    ]);
    for (const schema of ['tenant_a', 'tenant_b']) {
      expect(
        (await client.query('SELECT to_regclass($1) AS t', [`${schema}.notes`])).rows[0].t,
      ).not.toBeNull();
      expect(
        (await client.query('SELECT to_regclass($1) AS t', [`${schema}.notes_id_idx`])).rows[0].t,
      ).not.toBeNull();
      const journal = await client.query(`SELECT count(*)::int AS n FROM ${schema}.__drizzle_migrations`);
      expect(journal.rows[0].n).toBe(2);
    }
    expect((await client.query("SELECT to_regclass('public.notes') AS t")).rows[0].t).toBeNull();
    expect((await client.query('SHOW search_path')).rows[0].search_path).toBe('"$user", public');
    // В tenant_c таблица уже есть — первая миграция падает, tenant_d не начинается.
    await client.query('CREATE SCHEMA tenant_c');
    await client.query('CREATE TABLE tenant_c.notes (id integer)');
    const failure = await runMigrationsForSchemas(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      schemas: ['tenant_a', 'tenant_c', 'tenant_d'],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MultiSchemaMigrationError);
    expect(
      (failure as MultiSchemaMigrationError).reports.map((report) => [report.schema, report.status]),
    ).toEqual([
      ['tenant_a', 'applied'],
      ['tenant_c', 'failed'],
      ['tenant_d', 'not-started'],
    ]);
    const all = await runMigrationsForSchemas(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      schemas: ['tenant_c', 'tenant_d'],
      continueOnError: true,
    }).catch((error: unknown) => error as MultiSchemaMigrationError);
    expect(
      (all as MultiSchemaMigrationError).reports.map((report) => [report.schema, report.status]),
    ).toEqual([
      ['tenant_c', 'failed'],
      ['tenant_d', 'applied'],
    ]);
  });
});
