import type { Client } from 'pg';

import { createSchemaIfMissing } from './create-schema-if-missing';
import { MultiSchemaMigrationError } from './multi-schema-migration.error';
import { quoteIdent } from './quote-ident';
import { runMigrations } from './run-migrations';
import type { MultiSchemaOptions } from './types/multi-schema-options.type';
import type { SchemaRunReport } from './types/schema-run-report.type';

/**
 * Одни и те же миграции по списку схем (схема на арендатора): для каждой —
 * `runMigrations` с журналом в этой схеме и `search_path` = схема на время её
 * миграций (операторы без схемы попадают в неё). Отчёт по каждой схеме;
 * отказ — `MultiSchemaMigrationError` с отчётами, по умолчанию после первой
 * упавшей схемы (остальные — `not-started`), с `continueOnError` — после всех.
 * Отмена (`signal`) останавливает обход всегда: оставшиеся — `not-started`,
 * наружу — `MultiSchemaMigrationError`, если отмена прервала схему, иначе
 * `signal.reason`. Схема, которую одновременно создаёт соседний запуск, —
 * не отказ.
 */
export async function runMigrationsForSchemas(
  client: Client,
  options: MultiSchemaOptions,
): Promise<SchemaRunReport[]> {
  const { schemas, continueOnError, ...rest } = options;
  if (schemas.length === 0) {
    throw new Error('runMigrationsForSchemas: список схем пуст');
  }
  const duplicates = schemas.filter((schema, index) => schemas.indexOf(schema) !== index);
  if (duplicates.length > 0 || schemas.some((schema) => schema.trim() === '')) {
    throw new Error(`runMigrationsForSchemas: пустые или повторённые схемы (${duplicates.join(', ')})`);
  }
  const reports: SchemaRunReport[] = [];
  let stopped = false;
  let cancelled = false;
  for (const schema of schemas) {
    // Отмена останавливает обход и с continueOnError: остальные схемы — не
    // начаты, а не «упали» по отмене одна за другой (с CREATE SCHEMA каждая).
    if (stopped || rest.signal?.aborted === true) {
      cancelled ||= !stopped;
      reports.push({ schema, status: 'not-started' });
      continue;
    }
    rest.log(`схема ${schema}: миграции`);
    try {
      await createSchemaIfMissing(client, schema);
      await client.query("SELECT set_config('search_path', $1, false)", [quoteIdent(schema)]);
      const report = await runMigrations(client, { ...rest, schema, migrationsSchema: schema });
      reports.push({ schema, status: 'applied', report });
    } catch (error) {
      reports.push({ schema, status: 'failed', error });
      rest.log(
        `схема ${schema}: отказ — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
      stopped = continueOnError !== true;
    } finally {
      await client.query('RESET search_path').catch(() => undefined);
    }
  }
  if (reports.some((report) => report.status === 'failed')) {
    throw new MultiSchemaMigrationError(reports);
  }
  if (cancelled) {
    // Схемы остались не начатыми по отмене — это не успех.
    rest.signal?.throwIfAborted();
  }
  return reports;
}
