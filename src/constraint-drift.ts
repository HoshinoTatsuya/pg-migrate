import { CONSTRAINT_KIND_TITLE } from './constants/constraint-kind-title.constant';
import type { expectedConstraints } from './expected-constraints';
import type { SchemaDrift } from './types/schema-drift.type';

/**
 * Расхождение ограничений одной таблицы: первичный ключ — по набору колонок
 * (`схема.таблица PRIMARY KEY (a, b)`), остальные — по имени
 * (`схема.таблица.имя`, в `expected`/`actual` — вид). Вид, который снимок не
 * описывает, не сверяется.
 */
export function constraintDrift(
  qualified: string,
  expected: ReturnType<typeof expectedConstraints>,
  live: ReadonlyArray<{ readonly name: string; readonly type: string; readonly columns: readonly string[] }>,
): SchemaDrift[] {
  const drift: SchemaDrift[] = [];
  const livePrimaryKey = [...(live.find((row) => row.type === 'p')?.columns ?? [])].sort();
  const key = (columns: readonly string[]): string => `${qualified} PRIMARY KEY (${columns.join(', ')})`;
  if (expected.primaryKey.join(',') !== livePrimaryKey.join(',')) {
    if (expected.primaryKey.length > 0) {
      drift.push({ kind: 'missing-constraint', object: key(expected.primaryKey), expected: 'PRIMARY KEY' });
    }
    if (livePrimaryKey.length > 0) {
      drift.push({ kind: 'extra-constraint', object: key(livePrimaryKey), actual: 'PRIMARY KEY' });
    }
  }
  for (const [type, names] of [
    ['u', expected.unique],
    ['f', expected.foreign],
    ['c', expected.check],
  ] as const) {
    if (names === undefined) {
      continue;
    }
    const liveNames = new Set(live.filter((row) => row.type === type).map((row) => row.name));
    for (const name of names) {
      if (!liveNames.has(name)) {
        drift.push({
          kind: 'missing-constraint',
          object: `${qualified}.${name}`,
          expected: CONSTRAINT_KIND_TITLE[type],
        });
      }
    }
    for (const name of liveNames) {
      if (!names.has(name)) {
        drift.push({
          kind: 'extra-constraint',
          object: `${qualified}.${name}`,
          actual: CONSTRAINT_KIND_TITLE[type],
        });
      }
    }
  }
  return drift;
}
