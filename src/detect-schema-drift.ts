import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Client } from 'pg';

import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { constraintDrift } from './constraint-drift';
import { expectedConstraints } from './expected-constraints';
import { normalizeColumnType } from './normalize-column-type';
import { postgresIdentifier } from './postgres-identifier';
import { readJournalFile } from './read-journal-file';
import { snapshotEntry } from './snapshot-entry';
import type { DriftOptions } from './types/drift-options.type';
import type { DrizzleSnapshot } from './types/drizzle-snapshot.type';
import type { SchemaDrift } from './types/schema-drift.type';

/**
 * Сверка живой базы со снимком drizzle-kit (`meta/<idx>_snapshot.json`)
 * последней миграции каталога, ПРИМЕНЁННОЙ в базе (после фазы expand
 * contract-миграции ещё не применены, и снимок последней записи журнала описывал
 * бы схему, которой нет): таблицы, колонки (тип, NOT NULL, наличие DEFAULT),
 * индексы (в том числе INVALID) и ограничения (первичный ключ, UNIQUE, внешние
 * ключи, CHECK) схем, которые знает снимок. Ручная правка на проде (колонка,
 * индекс, снятый NOT NULL или PRIMARY KEY) иначе невидима до следующей
 * сломанной миграции. Только чтение каталога.
 *
 * Таблицы снимка без схемы — в `options.schema` (по умолчанию `public`): так
 * сверяется схема арендатора, мигрированная `runMigrationsForSchemas`.
 *
 * Пределы: DEFAULT сравнивается наличием, а не выражением (`now()` в снимке и
 * `now()` / `CURRENT_TIMESTAMP` в каталоге — одно и то же); тип — после
 * нормализации синонимов (`varchar` → `character varying`, serial → integer);
 * ограничения — по именам (первичный ключ — по колонкам), не по определению.
 * Индексы ограничений (первичный ключ, UNIQUE) лишними индексами не считаются —
 * они сверяются как ограничения.
 */
export async function detectSchemaDrift(client: Client, options: DriftOptions): Promise<SchemaDrift[]> {
  const journalFile = readJournalFile(options.migrationsFolder);
  const journalSchema = options.migrationsSchema ?? MIGRATE_DEFAULTS.JOURNAL_SCHEMA;
  const journalTable = options.migrationsTable ?? MIGRATE_DEFAULTS.JOURNAL_TABLE;
  const position = await snapshotEntry(client, options.migrationsFolder, journalFile, {
    schema: journalSchema,
    table: journalTable,
  });
  if (position === undefined) {
    return [];
  }
  const entry = journalFile.entries[position];
  const index = String(entry?.idx ?? position).padStart(4, '0');
  const snapshot = JSON.parse(
    readFileSync(join(options.migrationsFolder, 'meta', `${index}_snapshot.json`), 'utf8'),
  ) as DrizzleSnapshot;
  const defaultSchema = options.schema ?? MIGRATE_DEFAULTS.SCHEMA;
  const ignored = new Set([...(options.ignoreTables ?? []), `${journalSchema}.${journalTable}`]);
  const expected = Object.values(snapshot.tables).map((table) => ({
    ...table,
    schema: table.schema === '' ? defaultSchema : table.schema,
  }));
  const schemas = [...new Set(expected.map((table) => table.schema))];
  const { rows: columns } = await client.query<{
    schema: string;
    table: string;
    column: string;
    type: string;
    not_null: boolean;
    has_default: boolean;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
            format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, a.atthasdef AS has_default
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
        AND NOT c.relispartition`,
    [schemas],
  );
  const { rows: indexes } = await client.query<{
    schema: string;
    table: string;
    index: string;
    unique: boolean;
    valid: boolean;
    constraint: boolean;
  }>(
    `SELECT n.nspname AS schema, t.relname AS table, c.relname AS index, i.indisunique AS unique,
            i.indisvalid AS valid,
            EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid) AS constraint
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])`,
    [schemas],
  );
  const { rows: constraints } = await client.query<{
    schema: string;
    table: string;
    name: string;
    type: 'p' | 'u' | 'f' | 'c';
    columns: string[];
  }>(
    `SELECT n.nspname AS schema, t.relname AS table, k.conname AS name, k.contype::text AS type,
            ARRAY(SELECT a.attname::text FROM pg_attribute a
                   WHERE a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey) ORDER BY 1) AS columns
       FROM pg_constraint k
       JOIN pg_class t ON t.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND k.contype IN ('p', 'u', 'f', 'c')`,
    [schemas],
  );
  const drift: SchemaDrift[] = [];
  const liveTables = new Set(columns.map((row) => `${row.schema}.${row.table}`));
  const knownTables = new Set(expected.map((table) => `${table.schema}.${table.name}`));
  for (const table of expected) {
    const qualified = `${table.schema}.${table.name}`;
    if (ignored.has(qualified)) {
      continue;
    }
    if (!liveTables.has(qualified)) {
      drift.push({ kind: 'missing-table', object: qualified });
      continue;
    }
    const live = new Map(
      columns
        .filter((row) => row.schema === table.schema && row.table === table.name)
        .map((row) => [row.column, row]),
    );
    for (const column of Object.values(table.columns)) {
      const object = `${qualified}.${column.name}`;
      const actual = live.get(column.name);
      if (actual === undefined) {
        drift.push({ kind: 'missing-column', object });
        continue;
      }
      const want = normalizeColumnType(column.type);
      const have = normalizeColumnType(actual.type);
      if (want !== have) {
        drift.push({ kind: 'column-type', object, expected: want, actual: have });
      }
      if ((column.notNull === true) !== actual.not_null) {
        drift.push({
          kind: 'column-nullability',
          object,
          expected: column.notNull === true ? 'NOT NULL' : 'NULL',
          actual: actual.not_null ? 'NOT NULL' : 'NULL',
        });
      }
      const wantDefault = column.default !== undefined || /serial/i.test(column.type);
      if (wantDefault !== actual.has_default) {
        drift.push({
          kind: 'column-default',
          object,
          expected: wantDefault ? 'DEFAULT' : 'без DEFAULT',
          actual: actual.has_default ? 'DEFAULT' : 'без DEFAULT',
        });
      }
    }
    const declared = new Set(Object.keys(table.columns).map((key) => table.columns[key]?.name ?? key));
    for (const name of live.keys()) {
      if (!declared.has(name)) {
        drift.push({ kind: 'extra-column', object: `${qualified}.${name}` });
      }
    }
    const liveIndexes = new Map(
      indexes
        .filter((row) => row.schema === table.schema && row.table === table.name)
        .map((row) => [row.index, row]),
    );
    const declaredIndexes = Object.values(table.indexes ?? {}).map((declaredIndex) => ({
      ...declaredIndex,
      name: postgresIdentifier(declaredIndex.name),
    }));
    for (const declaredIndex of declaredIndexes) {
      const actual = liveIndexes.get(declaredIndex.name);
      const object = `${table.schema}.${declaredIndex.name}`;
      if (actual === undefined) {
        drift.push({ kind: 'missing-index', object });
        continue;
      }
      if (!actual.valid) {
        // INVALID-индекс (отказ CREATE INDEX CONCURRENTLY) запросам не служит, а
        // уникальность не держит — по имени он есть, по сути нет.
        drift.push({ kind: 'index-invalid', object, expected: 'VALID', actual: 'INVALID' });
      }
      if ((declaredIndex.isUnique === true) !== actual.unique) {
        drift.push({
          kind: 'index-uniqueness',
          object,
          expected: declaredIndex.isUnique === true ? 'UNIQUE' : 'не UNIQUE',
          actual: actual.unique ? 'UNIQUE' : 'не UNIQUE',
        });
      }
    }
    const declaredNames = new Set(declaredIndexes.map((declaredIndex) => declaredIndex.name));
    for (const [name, row] of liveIndexes) {
      if (!declaredNames.has(name) && !row.constraint) {
        drift.push({ kind: 'extra-index', object: `${table.schema}.${name}` });
      }
    }
    drift.push(
      ...constraintDrift(
        qualified,
        expectedConstraints(table),
        constraints.filter((row) => row.schema === table.schema && row.table === table.name),
      ),
    );
  }
  for (const qualified of liveTables) {
    if (!knownTables.has(qualified) && !ignored.has(qualified)) {
      drift.push({ kind: 'extra-table', object: qualified });
    }
  }
  return drift;
}
