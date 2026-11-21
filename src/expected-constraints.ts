import { postgresIdentifier } from './postgres-identifier';
import type { DrizzleSnapshot } from './types/drizzle-snapshot.type';

/**
 * Ограничения таблицы по снимку: первичный ключ — набором колонок (имя у
 * ключа колонки снимок не хранит), UNIQUE, внешние ключи и CHECK — по именам
 * (как их сохранит Postgres). Вид ограничения, которого в снимке нет вовсе
 * (ранняя версия drizzle-kit без `checkConstraints`), — `undefined`: не
 * сверяется, а не «ожидается ноль».
 */
export function expectedConstraints(table: DrizzleSnapshot['tables'][string]): {
  readonly primaryKey: readonly string[];
  readonly unique: ReadonlySet<string> | undefined;
  readonly foreign: ReadonlySet<string> | undefined;
  readonly check: ReadonlySet<string> | undefined;
} {
  const columns = Object.values(table.columns);
  const composite = Object.values(table.compositePrimaryKeys ?? {}).flatMap((key) => key.columns ?? []);
  const primaryKey = [
    ...new Set([
      ...columns.filter((column) => column.primaryKey === true).map((column) => column.name),
      ...composite,
    ]),
  ].sort();
  const names = (
    record: Record<string, { readonly name: string }> | undefined,
    extra: readonly string[] = [],
  ): ReadonlySet<string> | undefined =>
    record === undefined && extra.length === 0
      ? undefined
      : new Set([...Object.values(record ?? {}).map((item) => item.name), ...extra].map(postgresIdentifier));
  const columnUnique = columns
    .filter((column) => column.isUnique === true && typeof column.uniqueName === 'string')
    .map((column) => column.uniqueName as string);
  return {
    primaryKey,
    unique: names(table.uniqueConstraints, columnUnique),
    foreign: names(table.foreignKeys),
    check: names(table.checkConstraints),
  };
}
