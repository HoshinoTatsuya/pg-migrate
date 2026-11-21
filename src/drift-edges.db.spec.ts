import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectSchemaDrift } from './detect-schema-drift';
import { runMigrations } from './run-migrations';
import { runMigrationsForSchemas } from './run-migrations-for-schemas';
import { migratorDatabase } from './testing/migrator-database';
import { writeMigrations } from './testing/test-database';

const adminUrl = process.env.PG_TEST_URL;
const describeDb = adminUrl ? describe : describe.skip;

const BASE = 1_700_000_000_000;

type Column = { name: string; type: string; notNull?: boolean; primaryKey?: boolean; default?: string };

/** Таблица снимка drizzle-kit (version 7). */
const table = (
  name: string,
  columns: readonly Column[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name,
  schema: '',
  columns: Object.fromEntries(columns.map((column) => [column.name, { primaryKey: false, ...column }])),
  indexes: {},
  foreignKeys: {},
  compositePrimaryKeys: {},
  uniqueConstraints: {},
  policies: {},
  checkConstraints: {},
  isRLSEnabled: false,
  ...extra,
});

const writeSnapshot = (folder: string, index: number, tables: Record<string, unknown>): void => {
  writeFileSync(
    join(folder, 'meta', `${String(index).padStart(4, '0')}_snapshot.json`),
    JSON.stringify({ version: '7', dialect: 'postgresql', tables }),
  );
};

/**
 * Сверка схемы на настоящем Postgres: написания типов drizzle-kit против
 * `format_type`, ограничения, INVALID-индекс, схема арендатора, снимок
 * последней ПРИМЕНЁННОЙ миграции и имена длиннее 63 байт.
 */
describeDb('detectSchemaDrift: краевые случаи [нужен PG_TEST_URL]', () => {
  const { state, log, connect } = migratorDatabase(adminUrl);

  it('типы drizzle-kit с пробелом, точностью у зоны, char без длины и массивы синонимов — без ложного column-type', async () => {
    state.folder = writeMigrations([
      {
        tag: '0000_types',
        when: BASE,
        statements: [
          'CREATE TABLE prices (amount numeric(10, 2), at timestamptz(3), code char, tags int[], flags bool[], ats timestamptz(3)[])',
        ],
      },
    ]);
    writeSnapshot(state.folder, 0, {
      'public.prices': table('prices', [
        { name: 'amount', type: 'numeric(10, 2)' },
        { name: 'at', type: 'timestamptz(3)' },
        { name: 'code', type: 'char' },
        { name: 'tags', type: 'int[]' },
        { name: 'flags', type: 'bool[]' },
        { name: 'ats', type: 'timestamptz(3)[]' },
      ]),
    });
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(await detectSchemaDrift(client, { migrationsFolder: state.folder })).toEqual([]);
    // Контроль: настоящая смена типа по-прежнему видна.
    await client.query('ALTER TABLE prices ALTER COLUMN amount TYPE numeric(12,2)');
    expect(await detectSchemaDrift(client, { migrationsFolder: state.folder })).toEqual([
      {
        kind: 'column-type',
        object: 'public.prices.amount',
        expected: 'numeric(10,2)',
        actual: 'numeric(12,2)',
      },
    ]);
  });

  it('ограничения: снятые вручную PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK и добавленный CHECK — каждое названо', async () => {
    state.folder = writeMigrations([
      {
        tag: '0000_keys',
        when: BASE,
        statements: [
          'CREATE TABLE owners (id integer PRIMARY KEY)',
          "CREATE TABLE pets (owner integer NOT NULL, name text NOT NULL, chip text, CONSTRAINT pets_owner_name_pk PRIMARY KEY (owner, name), CONSTRAINT pets_chip_unique UNIQUE (chip), CONSTRAINT pets_owner_owners_id_fk FOREIGN KEY (owner) REFERENCES owners (id), CONSTRAINT pets_name_check CHECK (name <> ''))",
        ],
      },
    ]);
    writeSnapshot(state.folder, 0, {
      'public.owners': table('owners', [{ name: 'id', type: 'integer', notNull: true, primaryKey: true }]),
      'public.pets': table(
        'pets',
        [
          { name: 'owner', type: 'integer', notNull: true },
          { name: 'name', type: 'text', notNull: true },
          { name: 'chip', type: 'text' },
        ],
        {
          compositePrimaryKeys: {
            pets_owner_name_pk: { name: 'pets_owner_name_pk', columns: ['owner', 'name'] },
          },
          uniqueConstraints: { pets_chip_unique: { name: 'pets_chip_unique', columns: ['chip'] } },
          foreignKeys: { pets_owner_owners_id_fk: { name: 'pets_owner_owners_id_fk' } },
          checkConstraints: { pets_name_check: { name: 'pets_name_check', value: "name <> ''" } },
        },
      ),
    });
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(await detectSchemaDrift(client, { migrationsFolder: state.folder })).toEqual([]);
    await client.query('ALTER TABLE pets DROP CONSTRAINT pets_owner_owners_id_fk');
    await client.query('ALTER TABLE owners DROP CONSTRAINT owners_pkey');
    await client.query('ALTER TABLE pets DROP CONSTRAINT pets_owner_name_pk');
    await client.query('ALTER TABLE pets ADD PRIMARY KEY (owner)');
    await client.query('ALTER TABLE pets DROP CONSTRAINT pets_chip_unique');
    await client.query('ALTER TABLE pets DROP CONSTRAINT pets_name_check');
    await client.query('ALTER TABLE pets ADD CONSTRAINT pets_hotfix_check CHECK (owner > 0)');
    const drift = await detectSchemaDrift(client, { migrationsFolder: state.folder });
    expect(new Set(drift.map((item) => JSON.stringify(item)))).toEqual(
      new Set(
        [
          { kind: 'missing-constraint', object: 'public.owners PRIMARY KEY (id)', expected: 'PRIMARY KEY' },
          {
            kind: 'missing-constraint',
            object: 'public.pets PRIMARY KEY (name, owner)',
            expected: 'PRIMARY KEY',
          },
          { kind: 'extra-constraint', object: 'public.pets PRIMARY KEY (owner)', actual: 'PRIMARY KEY' },
          { kind: 'missing-constraint', object: 'public.pets.pets_chip_unique', expected: 'UNIQUE' },
          {
            kind: 'missing-constraint',
            object: 'public.pets.pets_owner_owners_id_fk',
            expected: 'FOREIGN KEY',
          },
          { kind: 'missing-constraint', object: 'public.pets.pets_name_check', expected: 'CHECK' },
          { kind: 'extra-constraint', object: 'public.pets.pets_hotfix_check', actual: 'CHECK' },
        ].map((item) => JSON.stringify(item)),
      ),
    );
    expect(drift).toHaveLength(7);
  });

  it('индекс с ожидаемым именем, но INVALID (отказ CREATE INDEX CONCURRENTLY) — index-invalid', async () => {
    state.folder = writeMigrations([
      {
        tag: '0000_t',
        when: BASE,
        statements: ['CREATE TABLE dup (k integer)', 'CREATE UNIQUE INDEX dup_k_idx ON dup (k)'],
      },
    ]);
    writeSnapshot(state.folder, 0, {
      'public.dup': table('dup', [{ name: 'k', type: 'integer' }], {
        indexes: { dup_k_idx: { name: 'dup_k_idx', isUnique: true } },
      }),
    });
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(await detectSchemaDrift(client, { migrationsFolder: state.folder })).toEqual([]);
    await client.query('DROP INDEX dup_k_idx');
    await client.query('INSERT INTO dup VALUES (1), (1)');
    await expect(client.query('CREATE UNIQUE INDEX CONCURRENTLY dup_k_idx ON dup (k)')).rejects.toThrow();
    expect(await detectSchemaDrift(client, { migrationsFolder: state.folder })).toEqual([
      { kind: 'index-invalid', object: 'public.dup_k_idx', expected: 'VALID', actual: 'INVALID' },
    ]);
  });

  it('схема арендатора (runMigrationsForSchemas): таблицы снимка без схемы сверяются в ней, а не в public', async () => {
    state.folder = writeMigrations([
      { tag: '0000_t', when: BASE, statements: ['CREATE TABLE notes (id integer)'] },
    ]);
    writeSnapshot(state.folder, 0, { 'public.notes': table('notes', [{ name: 'id', type: 'integer' }]) });
    const client = await connect();
    await runMigrationsForSchemas(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      schemas: ['tenant_a'],
    });
    const options = { migrationsFolder: state.folder, schema: 'tenant_a', migrationsSchema: 'tenant_a' };
    expect(await detectSchemaDrift(client, options)).toEqual([]);
    await client.query('ALTER TABLE tenant_a.notes ADD COLUMN hotfix text');
    expect(await detectSchemaDrift(client, options)).toEqual([
      { kind: 'extra-column', object: 'tenant_a.notes.hotfix' },
    ]);
  });

  it('после фазы expand — снимок последней ПРИМЕНЁННОЙ миграции, а не отложенной contract', async () => {
    state.folder = writeMigrations([
      { tag: '0000_t', when: BASE, statements: ['CREATE TABLE items (id integer, legacy text)'] },
      {
        tag: '0001_drop',
        when: BASE + 1000,
        statements: ['-- pg-migrate:phase=contract\nALTER TABLE items DROP COLUMN legacy'],
      },
    ]);
    writeSnapshot(state.folder, 0, {
      'public.items': table('items', [
        { name: 'id', type: 'integer' },
        { name: 'legacy', type: 'text' },
      ]),
    });
    writeSnapshot(state.folder, 1, { 'public.items': table('items', [{ name: 'id', type: 'integer' }]) });
    const client = await connect();
    const expand = await runMigrations(client, {
      lockKey: 'k',
      migrationsFolder: state.folder,
      log,
      phase: 'expand',
    });
    expect(expand.deferred).toEqual(['0001_drop']);
    expect(await detectSchemaDrift(client, { migrationsFolder: state.folder })).toEqual([]);
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log, phase: 'contract' });
    expect(await detectSchemaDrift(client, { migrationsFolder: state.folder })).toEqual([]);
    // Журнал есть, а миграций каталога в нём нет — сверять не с чем: отказ, а не «расхождений нет».
    await expect(
      detectSchemaDrift(client, {
        migrationsFolder: state.folder,
        migrationsSchema: 'public',
        migrationsTable: 'other',
      }),
    ).resolves.toBeDefined();
    await client.query('CREATE TABLE public.other (id serial, hash text, created_at bigint)');
    await expect(
      detectSchemaDrift(client, {
        migrationsFolder: state.folder,
        migrationsSchema: 'public',
        migrationsTable: 'other',
      }),
    ).rejects.toThrow('нет ни одной миграции каталога');
  });

  it('имя индекса и ограничения длиннее 63 байт — сравнивается обрезанным, как его хранит Postgres', async () => {
    const longIndex = `items_${'very_long_column_name_'.repeat(4)}idx`;
    const longCheck = `items_${'very_long_condition_name_'.repeat(4)}check`;
    state.folder = writeMigrations([
      {
        tag: '0000_t',
        when: BASE,
        statements: [
          `CREATE TABLE items (id integer, CONSTRAINT "${longCheck}" CHECK (id > 0))`,
          `CREATE INDEX "${longIndex}" ON items (id)`,
        ],
      },
    ]);
    writeSnapshot(state.folder, 0, {
      'public.items': table('items', [{ name: 'id', type: 'integer' }], {
        indexes: { [longIndex]: { name: longIndex, isUnique: false } },
        checkConstraints: { [longCheck]: { name: longCheck } },
      }),
    });
    const client = await connect();
    await runMigrations(client, { lockKey: 'k', migrationsFolder: state.folder, log });
    expect(longIndex.length).toBeGreaterThan(63);
    expect(await detectSchemaDrift(client, { migrationsFolder: state.folder })).toEqual([]);
  });
});
